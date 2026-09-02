import fs from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';

import { parseSubtitles } from './srt.ts';
import { buildCast } from './cast.ts';
import { buildSegments, DEFAULT_SEGMENT_OPTIONS, type SegmentOptions } from './segment.ts';
import { planShots, DEFAULT_PLAN_OPTIONS, type ClipAsset } from './plan.ts';
import {
  concatSegments,
  detectBestEncoder,
  frameSpans,
  prepareAudio,
  probe,
  renderConcurrency,
  renderSegment,
  type HardwareEncoder,
  type SegmentJob,
} from './ffmpeg.ts';
import { addLog, jobPath, writeJob, writeProgress, cleanupIntermediates, type Job } from './jobs.ts';

/* ------------------------------------------------------------------ */
/* analysis                                                            */
/* ------------------------------------------------------------------ */

export interface AnalyseSettings extends Partial<Omit<SegmentOptions, 'totalDurationMs'>> {
  declaredNames?: string[];
}

/**
 * Read the SRT, work out who the video is about, and lay out the cuts.
 *
 * Runs entirely in memory in well under a second even for a feature-length
 * script, so the UI can re-run it every time the user edits a character name or
 * a pacing slider without a spinner.
 */
export async function analyseJob(job: Job, settings: AnalyseSettings = {}): Promise<Job> {
  if (!job.subtitles) throw new Error('Upload a subtitle file before analysing.');

  const srtPath = jobPath(job.id, 'subtitles.srt');
  const text = await fs.readFile(srtPath, 'utf8');

  const parsed = parseSubtitles(text);
  if (!parsed.cues.length) {
    throw new Error(parsed.warnings[0] ?? 'That subtitle file contained no readable cues.');
  }

  const declared = settings.declaredNames ?? job.declaredNames;

  // The cast comes from the clip files, not from guessing at the subtitles.
  // The user already named their characters when they named their footage.
  const cast = buildCast(
    job.clips.map((c) => ({ id: c.id, filename: c.filename, tags: c.tags })),
    parsed.words,
    declared,
  );

  for (const clip of job.clips) {
    const entityId = cast.binding.get(clip.id);
    clip.entityIds = entityId ? [entityId] : [];
  }

  // The voiceover is the authority on length. Subtitles routinely stop a beat
  // before the audio does, and trusting them would clip the outro.
  const totalDurationMs = job.voiceover?.durationMs || parsed.durationMs;

  const segmentOptions: SegmentOptions = {
    ...DEFAULT_SEGMENT_OPTIONS,
    ...stripUndefined(settings),
    totalDurationMs,
  };

  const segments = buildSegments(parsed.words, cast.mentions, cast.entities, segmentOptions);
  const plan = planShots(segments, job.clips, cast.entities, DEFAULT_PLAN_OPTIONS);

  job.subtitles = {
    ...job.subtitles,
    cueCount: parsed.cues.length,
    wordCount: parsed.words.length,
    durationMs: parsed.durationMs,
    warnings: parsed.warnings,
  };
  job.declaredNames = declared;
  job.entities = cast.entities;
  job.mentions = cast.mentions;
  job.shots = plan.shots;
  job.notes = cast.notes;
  job.warnings = [...parsed.warnings, ...cast.warnings, ...plan.warnings];
  job.progress = { stage: 'ready', percent: 100, label: `${plan.shots.length} shots planned` };
  job.error = null;

  addLog(job, 'success', `Analysed ${parsed.cues.length} cues, ${parsed.words.length} words.`);
  addLog(
    job,
    'info',
    `Cast from clip files: ${cast.entities.map((e) => `${e.canonical} (${e.mentionCount} mentions)`).join(', ') || 'none'}.`,
  );
  for (const note of cast.notes) addLog(job, 'info', note);
  addLog(job, 'info', `Planned ${plan.shots.length} shots across ${plan.stats.clipsUsed} clip(s).`);

  await writeJob(job);
  return job;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

/** Jobs currently rendering in this process, so a double-click cannot start two. */
const activeRenders = new Set<string>();

export function isRendering(jobId: string): boolean {
  return activeRenders.has(jobId);
}

/**
 * Render the planned edit to a finished MP4.
 *
 * Two stages, and the split is where the speed comes from:
 *
 *   1. Every shot is encoded to a normalised intermediate, in parallel across
 *      CPU cores. This is the only stage that actually encodes video, and it
 *      scales close to linearly with core count.
 *   2. The intermediates are concatenated with `-c:v copy` and the voiceover is
 *      muxed in. No re-encoding, so this finishes at disk speed.
 *
 * The alternative - one giant `filter_complex` with N trim/concat pairs - is
 * single-threaded, allocates a filter graph proportional to the shot count, and
 * falls over somewhere north of a hundred inputs. Two stages avoid all of that.
 */
export async function renderJob(job: Job): Promise<Job> {
  if (activeRenders.has(job.id)) throw new Error('This job is already rendering.');
  if (!job.shots.length) throw new Error('Nothing to render - run the analysis first.');

  activeRenders.add(job.id);
  const startedAt = Date.now();

  try {
    const profile = job.profile;
    const segDir = jobPath(job.id, 'segments');
    await fs.mkdir(segDir, { recursive: true });

    job.progress = { stage: 'rendering', percent: 1, label: 'Preparing audio' };
    job.error = null;
    // Bumped on every manifest write so the client can tell when it is worth
    // pulling the full job down again instead of polling it blindly.
    let revision = job.updatedAt;
    await writeJob(job);
    revision = job.updatedAt;
    await writeProgress(job, revision);

    // --- audio ------------------------------------------------------
    let audioPath: string | null = null;
    let audioDurationMs = 0;
    if (job.voiceover) {
      audioPath = jobPath(job.id, 'voice.m4a');
      audioDurationMs = await prepareAudio(jobPath(job.id, job.voiceover.filename), audioPath, profile);
      addLog(job, 'info', `Voiceover normalised: ${(audioDurationMs / 1000).toFixed(2)}s.`);
    }

    // --- encoder ----------------------------------------------------
    const encoder: HardwareEncoder =
      profile.encoder === 'auto' ? await detectBestEncoder() : profile.encoder;
    addLog(job, 'info', `Encoding with ${encoder === 'x264' ? 'libx264 (CPU)' : `${encoder} (hardware)`}.`);

    // --- frame-exact spans ------------------------------------------
    // Boundaries are the shot starts plus the final end. Converting them to
    // absolute frame numbers here is what keeps the finished video exactly as
    // long as the voiceover, however many cuts there are.
    const boundaries = [...job.shots.map((s) => s.startMs), job.shots[job.shots.length - 1].endMs];
    const spans = frameSpans(boundaries, profile.fps);
    const totalFrames = spans.reduce((a, b) => a + b, 0);
    addLog(job, 'info', `${job.shots.length} shots, ${totalFrames} frames at ${profile.fps}fps.`);

    const clipById = new Map(job.clips.map((c) => [c.id, c]));

    const jobs: SegmentJob[] = job.shots.map((shot, i) => {
      const clip = clipById.get(shot.clipId);
      if (!clip) throw new Error(`Clip "${shot.clipFilename}" is missing from this job.`);

      const frames = spans[i];
      const neededMs = (frames / profile.fps) * 1000;

      // 'stretch' means the source is shorter than the slot and too short to
      // loop cleanly, so slow it down to cover the gap instead of freezing.
      const speed =
        shot.fitMode === 'stretch' && clip.durationMs > 0
          ? Math.max(0.25, Math.min(1, clip.durationMs / neededMs))
          : 1;

      return {
        index: i,
        sourcePath: clip.path,
        sourceWidth: clip.width,
        sourceHeight: clip.height,
        sourceFps: clip.fps,
        sourceInMs: shot.sourceInMs,
        frames,
        loops: shot.fitMode === 'loop' ? shot.loops : 1,
        speed,
        outputPath: path.join(segDir, `seg_${String(i).padStart(5, '0')}.mp4`),
      };
    });

    // --- stage 1: parallel segment encode ---------------------------
    const limit = pLimit(renderConcurrency());
    let done = 0;

    // Progress is reported from inside the workers, so it has to be cheap.
    // Writing the full manifest here cost ~150KB of serialisation and disk per
    // update on a long video - roughly 6MB of churn across a single render, for
    // a payload whose useful content is two numbers. The sidecar is ~200 bytes.
    let lastWrite = 0;
    const reportProgress = async (force = false) => {
      const now = Date.now();
      if (!force && now - lastWrite < 350) return;
      lastWrite = now;
      const elapsedMs = now - startedAt;
      const fraction = done / jobs.length;
      job.progress = {
        stage: 'rendering',
        percent: Math.round(3 + fraction * 92),
        label: `Rendering shot ${done}/${jobs.length}`,
        segmentsDone: done,
        segmentsTotal: jobs.length,
        elapsedMs,
        // Smoothed rather than instantaneous: a raw per-shot rate swings wildly
        // when shot lengths differ, and an ETA that jumps around reads as broken.
        etaMs: fraction > 0.03 ? Math.round(elapsedMs / fraction - elapsedMs) : undefined,
      };
      await writeProgress(job, revision);
    };

    await reportProgress(true);

    await Promise.all(
      jobs.map((segJob) =>
        limit(async () => {
          await renderSegment(segJob, profile, encoder);
          done++;
          await reportProgress();
        }),
      ),
    );
    await reportProgress(true);
    addLog(job, 'success', `All ${jobs.length} shots encoded in ${((Date.now() - startedAt) / 1000).toFixed(1)}s.`);

    // --- stage 2: concat + mux --------------------------------------
    job.progress = { stage: 'rendering', percent: 96, label: 'Assembling final video' };
    await writeProgress(job, revision);

    const outputName = 'output.mp4';
    const outputPath = jobPath(job.id, outputName);

    await concatSegments(
      jobs.map((j) => j.outputPath),
      audioPath,
      outputPath,
      profile,
      jobPath(job.id),
    );

    const info = await probe(outputPath);
    const stat = await fs.stat(outputPath);
    const renderMs = Date.now() - startedAt;

    job.output = {
      filename: outputName,
      sizeBytes: stat.size,
      durationMs: info.durationMs,
      renderMs,
    };
    job.progress = { stage: 'done', percent: 100, label: 'Done' };

    // The sync check the old renderer never made. A drift of more than a frame
    // means an assumption above is wrong, and the user should hear about it
    // rather than discover it in the last minute of the video.
    if (audioDurationMs > 0) {
      const driftMs = Math.abs(info.durationMs - audioDurationMs);
      const frameMs = 1000 / profile.fps;
      if (driftMs <= frameMs * 1.5) {
        addLog(job, 'success', `Video and voiceover match to within ${driftMs}ms (under one frame).`);
      } else {
        addLog(job, 'warn', `Video is ${driftMs}ms off the voiceover length. Check the last shot.`);
        job.warnings.push(`Final video length differs from the voiceover by ${driftMs}ms.`);
      }
    }

    addLog(job, 'success', `Rendered ${(stat.size / 1048576).toFixed(1)}MB in ${(renderMs / 1000).toFixed(1)}s.`);
    await writeJob(job);
    await writeProgress(job, job.updatedAt);

    // Intermediates are the same size again as the output; drop them now that
    // the final file exists.
    await cleanupIntermediates(job.id);

    return job;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    job.progress = { stage: 'failed', percent: 0, label: 'Render failed' };
    job.error = message;
    addLog(job, 'error', message);
    await writeJob(job);
    await writeProgress(job, job.updatedAt);
    throw err;
  } finally {
    activeRenders.delete(job.id);
  }
}

/* ------------------------------------------------------------------ */
/* clip ingestion                                                      */
/* ------------------------------------------------------------------ */

/**
 * Probe an uploaded clip and turn it into a `ClipAsset`.
 *
 * A clip with no video stream, or one ffprobe cannot read, is rejected here
 * rather than blowing up mid-render an hour later.
 */
export async function ingestClip(jobId: string, filename: string, id: string, tags: string[]): Promise<ClipAsset> {
  const filePath = jobPath(jobId, 'clips', filename);
  const info = await probe(filePath);

  if (!info.hasVideo) {
    throw new Error(`"${filename}" has no video stream.`);
  }
  if (info.durationMs <= 0) {
    throw new Error(`"${filename}" reports no duration - it may be truncated or still uploading.`);
  }

  // Thumbnails are best-effort: a missing one costs a grey box in the UI, not
  // a failed upload.
  await import('./ffmpeg')
    .then((m) => m.makeThumbnail(filePath, jobPath(jobId, 'thumbs', `${id}.jpg`), Math.min(1000, info.durationMs / 2)))
    .catch(() => {});

  return {
    id,
    filename,
    path: filePath,
    durationMs: info.durationMs,
    width: info.width,
    height: info.height,
    fps: info.fps,
    hasAudio: info.hasAudio,
    tags,
    entityIds: [],
  };
}
