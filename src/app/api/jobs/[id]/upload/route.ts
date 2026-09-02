import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';

import { addLog, jobPath, writeJob } from '@/lib/jobs';
import { ingestClip } from '@/lib/pipeline';
import { probe } from '@/lib/ffmpeg';
import {
  AUDIO_EXTENSIONS,
  SUBTITLE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  extensionOf,
  fail,
  ok,
  requireJob,
  safeFilename,
} from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Uploads of large clips can legitimately take a while. */
export const maxDuration = 3600;

type Params = { params: Promise<{ id: string }> };

/**
 * PUT /api/jobs/:id/upload?kind=clip|voiceover|subtitles&name=<filename>
 *
 * The file is the raw request body and is streamed straight to disk. The
 * obvious alternative, `await request.formData()`, buffers the entire upload in
 * memory first - fine for an SRT, ruinous for thirty 200MB clips, which is
 * exactly the workload here. Streaming keeps memory flat regardless of size.
 */
export async function PUT(request: Request, { params }: Params) {
  const { id } = await params;
  const found = await requireJob(id);
  if ('response' in found) return found.response;
  const job = found.job;

  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  const rawName = url.searchParams.get('name') ?? '';
  const tags = (url.searchParams.get('tags') ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  if (!request.body) return fail('No file was sent.');
  if (kind !== 'clip' && kind !== 'voiceover' && kind !== 'subtitles') {
    return fail(`Unknown upload kind "${kind}".`);
  }

  const filename = safeFilename(rawName, `upload-${Date.now()}`);
  const ext = extensionOf(filename);

  const allowed =
    kind === 'clip' ? VIDEO_EXTENSIONS : kind === 'voiceover' ? AUDIO_EXTENSIONS : SUBTITLE_EXTENSIONS;
  if (ext && !allowed.has(ext)) {
    return fail(`"${filename}" is not a supported ${kind} format. Expected one of ${[...allowed].join(', ')}.`);
  }

  try {
    if (kind === 'subtitles') {
      const target = jobPath(id, 'subtitles.srt');
      await streamToFile(request.body, target);

      job.subtitles = { filename, cueCount: 0, wordCount: 0, durationMs: 0, warnings: [] };
      addLog(job, 'info', `Subtitles uploaded: ${filename}.`);
      await writeJob(job);
      return ok({ job });
    }

    if (kind === 'voiceover') {
      // Keep the original extension: ffmpeg picks its demuxer from it, and
      // guessing wrong on a .wav-named-.mp3 is a needless failure.
      const stored = `voiceover${ext || '.mp3'}`;
      const target = jobPath(id, stored);
      await streamToFile(request.body, target);

      const info = await probe(target);
      if (!info.hasAudio) {
        await fsp.rm(target, { force: true });
        return fail(`"${filename}" has no audio stream.`);
      }

      job.voiceover = { filename: stored, durationMs: info.durationMs };
      addLog(job, 'info', `Voiceover uploaded: ${filename} (${(info.durationMs / 1000).toFixed(1)}s).`);
      await writeJob(job);
      return ok({ job });
    }

    // --- clip -------------------------------------------------------
    const clipId = randomUUID();
    // Prefix with the id so two clips named "drake.mp4" cannot collide.
    const stored = `${clipId}${ext || '.mp4'}`;
    await streamToFile(request.body, jobPath(id, 'clips', stored));

    const asset = await ingestClip(id, stored, clipId, tags);
    // Show the user the name they uploaded, not our storage name.
    asset.filename = filename;
    asset.path = jobPath(id, 'clips', stored);

    job.clips.push(asset);
    addLog(job, 'info', `Clip added: ${filename} (${(asset.durationMs / 1000).toFixed(1)}s, ${asset.width}x${asset.height}).`);
    await writeJob(job);
    return ok({ job, clip: asset });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addLog(job, 'error', `Upload failed for ${filename}: ${message}`);
    await writeJob(job).catch(() => {});
    return fail(message, 500);
  }
}

/** DELETE /api/jobs/:id/upload?clipId=... - remove one clip. */
export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  const found = await requireJob(id);
  if ('response' in found) return found.response;
  const job = found.job;

  const clipId = new URL(request.url).searchParams.get('clipId');
  const index = job.clips.findIndex((c) => c.id === clipId);
  if (index === -1) return fail('No such clip.', 404);

  const [removed] = job.clips.splice(index, 1);
  await fsp.rm(removed.path, { force: true }).catch(() => {});
  await fsp.rm(jobPath(id, 'thumbs', `${removed.id}.jpg`), { force: true }).catch(() => {});

  // The plan referenced this clip, so it is no longer valid.
  job.shots = [];
  addLog(job, 'info', `Clip removed: ${removed.filename}.`);
  await writeJob(job);

  return ok({ job });
}

/** Pipe a web ReadableStream to disk without buffering it. */
async function streamToFile(body: ReadableStream<Uint8Array>, target: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await pipeline(Readable.fromWeb(body as never), fs.createWriteStream(target));
}
