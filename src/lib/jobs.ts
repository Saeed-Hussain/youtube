import { randomUUID } from 'node:crypto';
import type { Entity, Mention } from './entities.ts';
import type { Shot } from './plan.ts';
import type { RenderProfile } from './ffmpeg.ts';
import { storage } from './storage.ts';

/**
 * Job storage.
 *
 * Every job is a small JSON manifest plus a set of media objects, all held by
 * the storage adapter - the local filesystem in development, Vercel Blob in
 * production. Nothing here touches disk directly, because on a serverless host
 * there is no disk worth touching: the only writable path is `/tmp`, and it is
 * neither shared between instances nor guaranteed to survive to the next
 * request.
 *
 * There is still deliberately no database. A manifest is a file, and job state
 * is small enough that reading and rewriting it whole is cheaper than any
 * schema would be.
 */

export type JobStage =
  | 'created'
  | 'analysing'
  | 'ready'
  | 'rendering'
  | 'assembling'
  | 'done'
  | 'failed';

export interface LogEntry {
  at: number;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

export interface JobProgress {
  stage: JobStage;
  /** 0-100. */
  percent: number;
  label: string;
  shotsDone?: number;
  shotsTotal?: number;
  elapsedMs?: number;
  etaMs?: number;
}

export interface ProgressSnapshot extends JobProgress {
  updatedAt: number;
  error: string | null;
  /** True while there is more work for the client to drive. */
  more: boolean;
}

export interface StoredClip {
  id: string;
  filename: string;
  /** Storage key, not a filesystem path. */
  key: string;
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  tags: string[];
  entityIds: string[];
}

/**
 * Progress through a chunked render.
 *
 * A serverless function cannot run for the length of a video render, so the
 * work is split into resumable steps and the client drives the loop. All the
 * state needed to pick up where the last invocation stopped lives here, in the
 * manifest, because the process that ran the previous step no longer exists.
 */
export interface RenderState {
  startedAt: number;
  encoder: string;
  /** Exact output frame count per shot - the anti-drift anchor. */
  frames: number[];
  audioKey: string | null;
  audioDurationMs: number;
  /** Every shot below this index has been encoded and uploaded. */
  nextShot: number;
  /** Every shot below this index has been folded into a part file. */
  assembledUpTo: number;
  /** Keys of the intermediate part files, in order. */
  parts: string[];
  /** Wall-clock spent encoding, accumulated across steps. */
  workMs: number;
}

export interface Job {
  id: string;
  createdAt: number;
  updatedAt: number;
  progress: JobProgress;

  subtitles: { filename: string; cueCount: number; wordCount: number; durationMs: number } | null;
  voiceover: { filename: string; key: string; durationMs: number } | null;

  clips: StoredClip[];
  entities: Entity[];
  mentions: Mention[];
  shots: Shot[];

  declaredNames: string[];
  profile: RenderProfile;
  render: RenderState | null;

  notes: string[];
  warnings: string[];
  logs: LogEntry[];

  output: { key: string; url: string; sizeBytes: number; durationMs: number; renderMs: number } | null;
  error: string | null;
}

/* ------------------------------------------------------------------ */
/* keys                                                                */
/* ------------------------------------------------------------------ */

export const keys = {
  job: (id: string) => `jobs/${id}/job.json`,
  progress: (id: string) => `jobs/${id}/progress.json`,
  subtitles: (id: string) => `jobs/${id}/subtitles.srt`,
  voiceover: (id: string, ext: string) => `jobs/${id}/voiceover${ext}`,
  audio: (id: string) => `jobs/${id}/voice.m4a`,
  clip: (id: string, clipId: string, ext: string) => `jobs/${id}/clips/${clipId}${ext}`,
  thumb: (id: string, clipId: string) => `jobs/${id}/thumbs/${clipId}.jpg`,
  segment: (id: string, index: number) => `jobs/${id}/segments/seg_${String(index).padStart(5, '0')}.mp4`,
  part: (id: string, index: number) => `jobs/${id}/parts/part_${String(index).padStart(4, '0')}.mp4`,
  output: (id: string) => `jobs/${id}/output.mp4`,
  prefix: (id: string) => `jobs/${id}/`,
};

/** Reject anything that is not one of our own generated ids. */
export function isValidJobId(id: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(id);
}

/* ------------------------------------------------------------------ */

export function defaultProfile(): RenderProfile {
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    quality: 23,
    encoder: 'auto',
    audioBitrate: '192k',
    fill: 'pad',
  };
}

export async function createJob(): Promise<Job> {
  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    progress: { stage: 'created', percent: 0, label: 'Waiting for files' },
    subtitles: null,
    voiceover: null,
    clips: [],
    entities: [],
    mentions: [],
    shots: [],
    declaredNames: [],
    profile: defaultProfile(),
    render: null,
    notes: [],
    warnings: [],
    logs: [],
    output: null,
    error: null,
  };
  await writeJob(job);
  return job;
}

export async function readJob(id: string): Promise<Job | null> {
  if (!isValidJobId(id)) return null;
  return storage().getJson<Job>(keys.job(id));
}

export async function writeJob(job: Job): Promise<void> {
  job.updatedAt = Date.now();
  await storage().putJson(keys.job(job.id), job);
}

export async function writeProgress(job: Job, more: boolean): Promise<void> {
  const snapshot: ProgressSnapshot = {
    ...job.progress,
    updatedAt: Date.now(),
    error: job.error,
    more,
  };
  await storage().putJson(keys.progress(job.id), snapshot);
}

export async function readProgress(id: string): Promise<ProgressSnapshot | null> {
  if (!isValidJobId(id)) return null;
  return storage().getJson<ProgressSnapshot>(keys.progress(id));
}

export function addLog(job: Job, level: LogEntry['level'], message: string): void {
  job.logs.push({ at: Date.now(), level, message });
  // Keep the manifest small - it is rewritten whole on every change.
  if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200);
}

export async function deleteJob(id: string): Promise<void> {
  if (!isValidJobId(id)) return;
  await storage().removePrefix(keys.prefix(id));
}

/** Job ids present in storage, newest first. */
export async function listJobs(limit = 20): Promise<Job[]> {
  const objects = await storage().list('jobs/').catch(() => []);
  const ids = objects
    .filter((o) => o.key.endsWith('/job.json'))
    .map((o) => o.key.split('/')[1])
    .filter((id) => isValidJobId(id));

  const jobs = await Promise.all([...new Set(ids)].slice(0, 200).map((id) => readJob(id)));
  return jobs
    .filter((j): j is Job => j !== null)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/**
 * Delete jobs older than `maxAgeHours`.
 *
 * Rendered video and its intermediates are large, and on Blob they are billed,
 * so this runs opportunistically when a new job starts rather than needing a
 * scheduler.
 */
export async function pruneOldJobs(maxAgeHours = 24): Promise<number> {
  const cutoff = Date.now() - maxAgeHours * 3_600_000;
  const jobs = await listJobs(200);
  let removed = 0;
  for (const job of jobs) {
    if (job.createdAt < cutoff) {
      await deleteJob(job.id).catch(() => {});
      removed++;
    }
  }
  return removed;
}

/**
 * Confirm storage is usable before anything tries to write to it.
 *
 * On Vercel this catches the case that actually matters: the app deployed but
 * no Blob store was attached, so `BLOB_READ_WRITE_TOKEN` is unset, the adapter
 * fell back to the filesystem, and that filesystem is read-only. Checking up
 * front turns a confusing 500 into a sentence naming the missing piece.
 */
export async function checkStorage(): Promise<{ writable: boolean; kind: string; error?: string }> {
  const store = storage();
  const probe = `health/${randomUUID()}.json`;

  try {
    await store.putJson(probe, { ok: true });
    await store.remove(probe);
    return { writable: true, kind: store.kind };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const readOnly = code === 'EROFS' || code === 'EACCES' || code === 'EPERM';

    const error =
      store.kind === 'local' && process.env.VERCEL
        ? 'No Blob store is attached. On Vercel the filesystem is read-only, so ClipForge needs Vercel Blob for uploads and rendered video: create a Blob store in the project Storage tab and redeploy so BLOB_READ_WRITE_TOKEN is set.'
        : readOnly
          ? 'The storage directory is read-only. Set CLIPFORGE_DATA to a writable path.'
          : (err as Error).message;

    return { writable: false, kind: store.kind, error };
  }
}
