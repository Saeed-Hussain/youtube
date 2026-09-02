import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Entity, Mention } from './entities.ts';
import type { ClipAsset, Shot } from './plan.ts';
import type { RenderProfile } from './ffmpeg.ts';

/**
 * Filesystem-backed job storage - deliberately no database.
 *
 * Every job owns a directory holding its uploads, its intermediates and its
 * `job.json` manifest. That makes the whole system inspectable with a file
 * browser, trivially portable, and disposable: deleting the directory deletes
 * the job. It also removes the Supabase round-trip that the previous version
 * made on every state change.
 */

export const DATA_ROOT = process.env.CLIPFORGE_DATA ?? path.join(process.cwd(), '.data');
const JOBS_ROOT = path.join(DATA_ROOT, 'jobs');

export type JobStage =
  | 'created'
  | 'uploading'
  | 'analysing'
  | 'ready'
  | 'rendering'
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
  /** Populated during rendering. */
  segmentsDone?: number;
  segmentsTotal?: number;
  /** Milliseconds since the render started. */
  elapsedMs?: number;
  /** Best-effort projection of remaining time, in ms. */
  etaMs?: number;
}

export interface Job {
  id: string;
  createdAt: number;
  updatedAt: number;
  progress: JobProgress;

  subtitles: {
    filename: string;
    cueCount: number;
    wordCount: number;
    durationMs: number;
    warnings: string[];
  } | null;

  voiceover: {
    filename: string;
    durationMs: number;
  } | null;

  clips: ClipAsset[];
  entities: Entity[];
  mentions: Mention[];
  shots: Shot[];

  /** Character names typed in by the user, seeded before auto-discovery. */
  declaredNames: string[];
  profile: RenderProfile;

  notes: string[];
  warnings: string[];
  logs: LogEntry[];

  output: {
    filename: string;
    sizeBytes: number;
    durationMs: number;
    renderMs: number;
  } | null;

  error: string | null;
}

/**
 * The slice of a job the progress poller needs.
 *
 * Written to its own small file so a render can report progress without
 * re-serialising the whole manifest, and so the client can poll without
 * pulling the entire shot list down every 700ms. On a 23-minute video the
 * manifest is ~150KB and progress is under 200 bytes - roughly a 750x
 * reduction in both disk churn and poll traffic.
 */
export interface ProgressSnapshot extends JobProgress {
  updatedAt: number;
  error: string | null;
  /** Bumped whenever the full manifest changes, so the client knows to refetch. */
  revision: number;
}

export function jobDir(id: string): string {
  return path.join(JOBS_ROOT, id);
}

export function jobPath(id: string, ...parts: string[]): string {
  return path.join(jobDir(id), ...parts);
}

/** Reject anything that is not one of our own generated ids. */
export function isValidJobId(id: string): boolean {
  return /^[0-9a-f-]{36}$/i.test(id);
}

export async function createJob(): Promise<Job> {
  const id = randomUUID();
  const now = Date.now();

  await fs.mkdir(jobPath(id, 'clips'), { recursive: true });
  await fs.mkdir(jobPath(id, 'segments'), { recursive: true });
  await fs.mkdir(jobPath(id, 'thumbs'), { recursive: true });

  const job: Job = {
    id,
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
    profile: {
      width: 1920,
      height: 1080,
      fps: 30,
      quality: 21,
      encoder: 'auto',
      audioBitrate: '192k',
      fill: 'pad',
    },
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
  try {
    const raw = await fs.readFile(jobPath(id, 'job.json'), 'utf8');
    return JSON.parse(raw) as Job;
  } catch {
    return null;
  }
}

/**
 * Persist the manifest atomically.
 *
 * The progress poller reads `job.json` while the renderer writes it. Writing to
 * a temp file and renaming means a reader either sees the whole previous
 * manifest or the whole new one, never a half-written file - the rename is
 * atomic on both NTFS and POSIX filesystems.
 */
export async function writeJob(job: Job): Promise<void> {
  job.updatedAt = Date.now();
  const target = jobPath(job.id, 'job.json');
  const temp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(job, null, 2), 'utf8');
  await fs.rename(temp, target);
}

/** Read-modify-write helper so callers never race on a stale copy. */
export async function updateJob(id: string, mutate: (job: Job) => void | Promise<void>): Promise<Job> {
  const job = await readJob(id);
  if (!job) throw new Error(`Job ${id} not found.`);
  await mutate(job);
  await writeJob(job);
  return job;
}

/**
 * Write the progress sidecar.
 *
 * Not atomic, unlike the manifest: the file is a couple of hundred bytes, so a
 * torn read is vanishingly unlikely, and a reader that does hit one simply
 * falls back to the manifest rather than showing anything wrong.
 */
export async function writeProgress(job: Job, revision: number): Promise<void> {
  const snapshot: ProgressSnapshot = {
    ...job.progress,
    updatedAt: Date.now(),
    error: job.error,
    revision,
  };
  await fs.writeFile(jobPath(job.id, 'progress.json'), JSON.stringify(snapshot), 'utf8');
}

export async function readProgress(id: string): Promise<ProgressSnapshot | null> {
  if (!isValidJobId(id)) return null;
  try {
    return JSON.parse(await fs.readFile(jobPath(id, 'progress.json'), 'utf8')) as ProgressSnapshot;
  } catch {
    return null;
  }
}

export function addLog(job: Job, level: LogEntry['level'], message: string): void {
  job.logs.push({ at: Date.now(), level, message });
  // Keep the manifest small: a long render can emit thousands of lines and the
  // whole file is re-serialised on every write.
  if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
}

export async function deleteJob(id: string): Promise<void> {
  if (!isValidJobId(id)) return;
  await fs.rm(jobDir(id), { recursive: true, force: true });
}

export async function listJobs(): Promise<Job[]> {
  try {
    const ids = await fs.readdir(JOBS_ROOT);
    const jobs = await Promise.all(ids.map((id) => readJob(id)));
    return jobs
      .filter((j): j is Job => j !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

/**
 * Remove jobs older than `maxAgeHours`.
 *
 * Rendered video and its intermediates are large; without this the .data
 * directory grows without bound. Called opportunistically on job creation
 * rather than on a timer, so there is no background process to manage.
 */
export async function pruneOldJobs(maxAgeHours = 24): Promise<number> {
  const cutoff = Date.now() - maxAgeHours * 3_600_000;
  const jobs = await listJobs();
  let removed = 0;
  for (const job of jobs) {
    if (job.createdAt < cutoff) {
      await deleteJob(job.id);
      removed++;
    }
  }
  return removed;
}

/** Delete the per-shot intermediates once the final file exists. */
export async function cleanupIntermediates(id: string): Promise<void> {
  await fs.rm(jobPath(id, 'segments'), { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(jobPath(id, 'segments'), { recursive: true }).catch(() => {});
}
