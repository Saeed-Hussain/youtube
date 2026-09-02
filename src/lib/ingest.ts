import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { makeThumbnail, probe } from './ffmpeg.ts';
import { probeStored } from './render.ts';
import { addLog, keys, type Job, type StoredClip } from './jobs.ts';
import { clearScratch, scratchDir, storage } from './storage.ts';

export interface UploadRecord {
  kind: 'clip' | 'voiceover';
  /** Storage key the file now lives at. */
  key: string;
  /** The name the user's file had, for display. */
  filename: string;
  clipId?: string;
  /** Set when the file is still on local disk, so it can be probed without a download. */
  localPath?: string;
}

/**
 * Attach an uploaded file to a job.
 *
 * Shared by both upload paths - the streaming route used in development and the
 * direct-to-Blob path used in production - so a clip is validated and probed
 * identically however it arrived.
 */
export async function registerUpload(job: Job, upload: UploadRecord): Promise<Job> {
  const info = upload.localPath ? await probe(upload.localPath) : await probeStored(upload.key);

  if (upload.kind === 'voiceover') {
    if (!info.hasAudio) {
      await storage().remove(upload.key).catch(() => {});
      throw new Error(`"${upload.filename}" has no audio stream.`);
    }

    job.voiceover = {
      filename: upload.filename,
      key: upload.key,
      durationMs: info.durationMs,
    };
    addLog(job, 'info', `Voiceover added: ${upload.filename} (${(info.durationMs / 1000).toFixed(1)}s).`);
    // The plan depends on the voiceover length, so it has to be rebuilt.
    job.shots = [];
    return job;
  }

  if (!info.hasVideo) {
    await storage().remove(upload.key).catch(() => {});
    throw new Error(`"${upload.filename}" has no video stream.`);
  }
  if (info.durationMs <= 0) {
    await storage().remove(upload.key).catch(() => {});
    throw new Error(`"${upload.filename}" reports no duration - it may be truncated.`);
  }

  const clip: StoredClip = {
    id: upload.clipId ?? randomUUID(),
    filename: upload.filename,
    key: upload.key,
    durationMs: info.durationMs,
    width: info.width,
    height: info.height,
    fps: info.fps,
    hasAudio: info.hasAudio,
    tags: [],
    entityIds: [],
  };

  await makeClipThumbnail(job.id, clip, upload.localPath);

  job.clips.push(clip);
  job.shots = [];
  addLog(
    job,
    'info',
    `Clip added: ${clip.filename} (${(clip.durationMs / 1000).toFixed(1)}s, ${clip.width}x${clip.height}).`,
  );

  return job;
}

/**
 * Best effort poster frame.
 *
 * A missing thumbnail costs a grey box in the UI, never a failed upload, so
 * every error here is swallowed. When the source is remote FFmpeg reads it over
 * HTTP with range requests rather than pulling the whole clip down.
 */
async function makeClipThumbnail(jobId: string, clip: StoredClip, localPath?: string): Promise<void> {
  const scratch = scratchDir(jobId, `thumb-${clip.id}`);
  try {
    await fsp.mkdir(scratch, { recursive: true });
    const dest = path.join(scratch, 'thumb.jpg');

    const source = localPath ?? (await storage().urlFor(clip.key));
    if (!source) return;

    await makeThumbnail(source, dest, Math.min(1000, clip.durationMs / 2));
    await storage().putFile(keys.thumb(jobId, clip.id), dest, 'image/jpeg');
  } catch {
    /* a missing thumbnail is cosmetic */
  } finally {
    await clearScratch(scratch);
  }
}
