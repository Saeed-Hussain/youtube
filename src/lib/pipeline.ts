import { parseSubtitles } from './srt.ts';
import { buildCast } from './cast.ts';
import { buildSegments, DEFAULT_SEGMENT_OPTIONS, type SegmentOptions } from './segment.ts';
import { planShots, DEFAULT_PLAN_OPTIONS, type ClipAsset } from './plan.ts';
import { addLog, keys, writeJob, type Job } from './jobs.ts';
import { storage } from './storage.ts';

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

  // Subtitles are a few tens of kilobytes, so this is a cheap fetch even when
  // the store is remote.
  const text = await readSubtitles(job.id);

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
  const plan = planShots(segments, job.clips as ClipAsset[], cast.entities, DEFAULT_PLAN_OPTIONS);

  job.subtitles = {
    ...job.subtitles,
    cueCount: parsed.cues.length,
    wordCount: parsed.words.length,
    durationMs: parsed.durationMs,
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

/**
 * Read the subtitle file, wherever it is stored.
 *
 * A few tens of kilobytes, so pulling the whole thing is cheap even from a
 * remote store.
 */
async function readSubtitles(jobId: string): Promise<string> {
  const store = storage();
  const key = keys.subtitles(jobId);
  const url = await store.urlFor(key);
  if (!url) throw new Error('The subtitle file is missing - upload it again.');

  if (url.startsWith('http')) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('Could not read the subtitle file.');
    return res.text();
  }

  const os = await import('node:os');
  const nodePath = await import('node:path');
  const fsp = await import('node:fs/promises');
  const local = nodePath.join(os.tmpdir(), 'clipforge', `${jobId}.srt`);
  await store.fetchTo(key, local);
  const text = await fsp.readFile(local, 'utf8');
  await fsp.rm(local, { force: true }).catch(() => {});
  return text;
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

