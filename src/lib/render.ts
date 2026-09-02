import fs from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';

import {
  concatSegments,
  detectBestEncoder,
  exactDuration,
  frameSpans,
  prepareAudio,
  probe,
  renderConcurrency,
  renderSegment,
  type HardwareEncoder,
  type SegmentJob,
} from './ffmpeg.ts';
import { addLog, keys, writeJob, writeProgress, type Job } from './jobs.ts';
import { clearScratch, scratchDir, storage } from './storage.ts';

/**
 * Chunked, resumable rendering.
 *
 * A serverless function is killed at a hard wall-clock limit - 60s on Vercel's
 * Hobby plan, 300s on Pro - and anything still running when the response is
 * sent is frozen immediately. A twenty-minute video takes far longer than that
 * to encode, so the render cannot be one long call, and it cannot be
 * fire-and-forget either.
 *
 * Instead it is a state machine the client drives one step at a time. Each step
 * does as much work as fits in a time budget, records exactly where it stopped
 * in the manifest, and returns. The next step - almost certainly on a different
 * instance, with a different `/tmp` - reads that state and continues.
 *
 *   encode shots  ->  fold into part files  ->  concatenate parts + audio
 *
 * The middle stage exists purely to bound `/tmp`. Downloading several hundred
 * finished segments at once would exceed the 512MB scratch space, so segments
 * are folded into part files in groups as they become available, and only the
 * handful of parts is ever needed at the end.
 */

/** How long one step may work before returning, leaving headroom for upload. */
const STEP_BUDGET_MS = Number(process.env.CLIPFORGE_STEP_BUDGET_MS ?? 40_000);

/** Ceiling on source clips pulled into /tmp within a single step. */
const SCRATCH_BUDGET_BYTES = Number(process.env.CLIPFORGE_SCRATCH_BUDGET ?? 220 * 1024 * 1024);

/** Segments folded into one part file. */
const PART_SIZE = 40;

export interface StepResult {
  stage: Job['progress']['stage'];
  shotsDone: number;
  shotsTotal: number;
  percent: number;
  /** False once the video is finished or the render has failed. */
  more: boolean;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* start                                                               */
/* ------------------------------------------------------------------ */

/**
 * Prepare a render: normalise the audio, work out the frame budget, and record
 * the state the steps will advance. Cheap enough to finish well inside one
 * invocation even for a long video.
 */
export async function startRender(job: Job): Promise<void> {
  if (!job.shots.length) throw new Error('Run the analysis before rendering.');

  const scratch = scratchDir(job.id, 'start');
  const store = storage();

  try {
    await fs.mkdir(scratch, { recursive: true });

    let audioKey: string | null = null;
    let audioDurationMs = 0;

    if (job.voiceover) {
      const localIn = path.join(scratch, path.basename(job.voiceover.key));
      const localOut = path.join(scratch, 'voice.m4a');
      await store.fetchTo(job.voiceover.key, localIn);

      audioDurationMs = await prepareAudio(localIn, localOut, job.profile);
      audioKey = keys.audio(job.id);
      await store.putFile(audioKey, localOut, 'audio/mp4');
      addLog(job, 'info', `Voiceover normalised: ${(audioDurationMs / 1000).toFixed(2)}s.`);
    }

    const encoder: HardwareEncoder =
      job.profile.encoder === 'auto' ? await detectBestEncoder() : job.profile.encoder;

    // Absolute frame numbers, so shot lengths telescope and the finished video
    // is exactly as long as the narration however many cuts it has.
    const boundaries = [...job.shots.map((s) => s.startMs), job.shots[job.shots.length - 1].endMs];
    const frames = frameSpans(boundaries, job.profile.fps);

    job.render = {
      startedAt: Date.now(),
      encoder,
      frames,
      audioKey,
      audioDurationMs,
      nextShot: 0,
      assembledUpTo: 0,
      parts: [],
      workMs: 0,
    };
    job.output = null;
    job.error = null;
    job.progress = {
      stage: 'rendering',
      percent: 1,
      label: `Rendering shot 0/${job.shots.length}`,
      shotsDone: 0,
      shotsTotal: job.shots.length,
    };

    addLog(
      job,
      'info',
      `${job.shots.length} shots, ${frames.reduce((a, b) => a + b, 0)} frames at ${job.profile.fps}fps, ${encoder === 'x264' ? 'libx264' : encoder}.`,
    );

    await writeJob(job);
    await writeProgress(job, true);
  } finally {
    await clearScratch(scratch);
  }
}

/* ------------------------------------------------------------------ */
/* step                                                                */
/* ------------------------------------------------------------------ */

/** Advance the render by as much work as fits in one invocation. */
export async function renderStep(job: Job): Promise<StepResult> {
  const state = job.render;
  if (!state) throw new Error('This job has not started rendering.');

  const total = job.shots.length;
  const deadline = Date.now() + STEP_BUDGET_MS;
  const scratch = scratchDir(job.id, `step-${Date.now()}`);

  try {
    await fs.mkdir(scratch, { recursive: true });

    if (state.nextShot < total) {
      await encodeBatch(job, state, scratch, deadline);
    } else if (state.assembledUpTo < total) {
      await assembleParts(job, state, scratch, deadline);
    } else {
      await finalise(job, state, scratch);
      return result(job, false);
    }

    await writeJob(job);
    await writeProgress(job, true);
    return result(job, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    job.progress = { stage: 'failed', percent: 0, label: 'Render failed' };
    job.error = message;
    addLog(job, 'error', message);
    await writeJob(job);
    await writeProgress(job, false);
    return { ...result(job, false), error: message };
  } finally {
    // /tmp does not belong to us and may be reused by the next invocation on
    // this instance, so every step cleans up after itself.
    await clearScratch(scratch);
  }
}

function result(job: Job, more: boolean): StepResult {
  return {
    stage: job.progress.stage,
    shotsDone: job.progress.shotsDone ?? 0,
    shotsTotal: job.progress.shotsTotal ?? job.shots.length,
    percent: job.progress.percent,
    more,
  };
}

/* ------------------------------------------------------------------ */

/**
 * Encode as many shots as fit in the budget.
 *
 * Shots are taken strictly in order so that `nextShot` alone describes the
 * progress, but the source clips they need are downloaded once per step and
 * shared, since consecutive shots very often reuse the same footage.
 */
async function encodeBatch(job: Job, state: NonNullable<Job['render']>, scratch: string, deadline: number): Promise<void> {
  const store = storage();
  const clipById = new Map(job.clips.map((c) => [c.id, c]));
  const localClips = new Map<string, string>();
  let scratchBytes = 0;

  const ensureClip = async (clipId: string): Promise<string | null> => {
    const cached = localClips.get(clipId);
    if (cached) return cached;

    const clip = clipById.get(clipId);
    if (!clip) throw new Error(`Clip "${clipId}" is missing from this job.`);

    // Stop pulling new footage once /tmp is close to full; the next step picks
    // up from here with an empty scratch directory.
    if (scratchBytes > SCRATCH_BUDGET_BYTES && localClips.size > 0) return null;

    const local = path.join(scratch, 'clips', `${clipId}${path.extname(clip.key) || '.mp4'}`);
    await store.fetchTo(clip.key, local);
    scratchBytes += (await fs.stat(local)).size;
    localClips.set(clipId, local);
    return local;
  };

  const started = Date.now();
  let encoded = 0;

  while (state.nextShot < job.shots.length) {
    // Always encode at least one shot, otherwise a step that starts near the
    // deadline makes no progress and the client loops forever.
    if (encoded > 0 && Date.now() > deadline) break;

    // Gather a small run of consecutive shots that share already-local clips,
    // so the encoder can work on several at once.
    const batch: SegmentJob[] = [];
    const parallel = renderConcurrency();

    while (state.nextShot + batch.length < job.shots.length && batch.length < parallel) {
      const index = state.nextShot + batch.length;
      const shot = job.shots[index];
      const source = await ensureClip(shot.clipId);
      if (!source) break;

      const clip = clipById.get(shot.clipId)!;
      const frames = state.frames[index];
      const neededMs = (frames / job.profile.fps) * 1000;

      batch.push({
        index,
        sourcePath: source,
        sourceWidth: clip.width,
        sourceHeight: clip.height,
        sourceFps: clip.fps,
        sourceInMs: shot.sourceInMs,
        frames,
        loops: shot.fitMode === 'loop' ? shot.loops : 1,
        speed:
          shot.fitMode === 'stretch' && clip.durationMs > 0
            ? Math.max(0.25, Math.min(1, clip.durationMs / neededMs))
            : 1,
        outputPath: path.join(scratch, `seg_${String(index).padStart(5, '0')}.mp4`),
      });
    }

    if (!batch.length) break;

    const limit = pLimit(parallel);
    await Promise.all(
      batch.map((segJob) => limit(() => renderSegment(segJob, job.profile, state.encoder as HardwareEncoder))),
    );

    // Upload in parallel too - these are small files and the round trip
    // dominates.
    const uploadLimit = pLimit(4);
    await Promise.all(
      batch.map((segJob) =>
        uploadLimit(async () => {
          await store.putFile(keys.segment(job.id, segJob.index), segJob.outputPath, 'video/mp4');
          await fs.rm(segJob.outputPath, { force: true });
        }),
      ),
    );

    state.nextShot += batch.length;
    encoded += batch.length;
  }

  state.workMs += Date.now() - started;

  const fraction = state.nextShot / job.shots.length;
  job.progress = {
    stage: 'rendering',
    percent: Math.round(2 + fraction * 78),
    label: `Rendering shot ${state.nextShot}/${job.shots.length}`,
    shotsDone: state.nextShot,
    shotsTotal: job.shots.length,
    elapsedMs: state.workMs,
    etaMs: fraction > 0.03 ? Math.round(state.workMs / fraction - state.workMs) : undefined,
  };
}

/**
 * Fold a group of finished segments into a single part file.
 *
 * Stream copy only, so this is I/O bound rather than CPU bound, and it keeps
 * the final concatenation down to a handful of inputs instead of hundreds -
 * which is what stops `/tmp` overflowing on a long video.
 */
async function assembleParts(job: Job, state: NonNullable<Job['render']>, scratch: string, deadline: number): Promise<void> {
  const store = storage();
  const total = job.shots.length;

  while (state.assembledUpTo < total) {
    const from = state.assembledUpTo;
    const to = Math.min(from + PART_SIZE, total);

    const locals: string[] = [];
    for (let i = from; i < to; i++) {
      const local = path.join(scratch, `seg_${String(i).padStart(5, '0')}.mp4`);
      await store.fetchTo(keys.segment(job.id, i), local);
      locals.push(local);
    }

    const partIndex = state.parts.length;
    const partPath = path.join(scratch, `part_${partIndex}.mp4`);
    await concatSegments(locals, null, partPath, job.profile, scratch);

    const partKey = keys.part(job.id, partIndex);
    await store.putFile(partKey, partPath, 'video/mp4');
    state.parts.push(partKey);
    state.assembledUpTo = to;

    for (const local of [...locals, partPath]) await fs.rm(local, { force: true }).catch(() => {});

    const fraction = state.assembledUpTo / total;
    job.progress = {
      stage: 'assembling',
      percent: Math.round(80 + fraction * 15),
      label: `Assembling ${state.assembledUpTo}/${total}`,
      shotsDone: total,
      shotsTotal: total,
    };

    if (Date.now() > deadline) break;
  }
}

/** Join the parts, lay the voiceover over the top, and publish the result. */
async function finalise(job: Job, state: NonNullable<Job['render']>, scratch: string): Promise<void> {
  const store = storage();

  const locals: string[] = [];
  for (const [i, key] of state.parts.entries()) {
    const local = path.join(scratch, `part_${i}.mp4`);
    await store.fetchTo(key, local);
    locals.push(local);
  }

  let audioLocal: string | null = null;
  if (state.audioKey) {
    audioLocal = path.join(scratch, 'voice.m4a');
    await store.fetchTo(state.audioKey, audioLocal);
  }

  const outPath = path.join(scratch, 'output.mp4');
  await concatSegments(locals, audioLocal, outPath, job.profile, scratch);

  const stat = await fs.stat(outPath);
  const durationMs = await exactDuration(outPath);
  const stored = await store.putFile(keys.output(job.id), outPath, 'video/mp4');
  const renderMs = Date.now() - state.startedAt;

  job.output = {
    key: stored.key,
    url: stored.url,
    sizeBytes: stat.size,
    durationMs,
    renderMs,
  };
  job.progress = {
    stage: 'done',
    percent: 100,
    label: 'Done',
    shotsDone: job.shots.length,
    shotsTotal: job.shots.length,
  };

  // The sync check the original renderer never made. Drift beyond a frame means
  // an assumption above is wrong, and the user should hear it now rather than
  // discover it in the last minute of the video.
  if (state.audioDurationMs > 0) {
    const driftMs = Math.abs(durationMs - state.audioDurationMs);
    const frameMs = 1000 / job.profile.fps;
    if (driftMs <= frameMs * 1.5) {
      addLog(job, 'success', `Video and voiceover match to within ${driftMs}ms (under one frame).`);
    } else {
      addLog(job, 'warn', `Video is ${driftMs}ms off the voiceover length.`);
      job.warnings.push(`Final video length differs from the voiceover by ${driftMs}ms.`);
    }
  }

  addLog(job, 'success', `Rendered ${(stat.size / 1048576).toFixed(1)}MB in ${(renderMs / 1000).toFixed(1)}s.`);

  await writeJob(job);
  await writeProgress(job, false);

  // Intermediates are as large again as the output; drop them now the final
  // file exists.
  await store.removePrefix(`jobs/${job.id}/segments/`).catch(() => {});
  await store.removePrefix(`jobs/${job.id}/parts/`).catch(() => {});
}

/** Probe a stored object without pulling the whole thing down when possible. */
export async function probeStored(key: string): Promise<Awaited<ReturnType<typeof probe>>> {
  const store = storage();
  const url = await store.urlFor(key);

  // FFmpeg reads HTTP with range requests, so for a remote object it fetches
  // little more than the header. Falling back to a download keeps this working
  // if the build lacks HTTPS support or the file needs a full scan.
  if (url && url.startsWith('http')) {
    try {
      return await probe(url);
    } catch {
      /* fall through to the download */
    }
  }

  const scratch = scratchDir('probe', randomName());
  try {
    const local = path.join(scratch, path.basename(key));
    await store.fetchTo(key, local);
    return await probe(local);
  } finally {
    await clearScratch(scratch);
  }
}

function randomName(): string {
  return Math.random().toString(36).slice(2, 10);
}
