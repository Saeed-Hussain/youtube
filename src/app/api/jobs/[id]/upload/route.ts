import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';

import { addLog, keys, writeJob, type Job } from '@/lib/jobs';
import { storage, scratchDir, clearScratch, isServerless } from '@/lib/storage';
import { registerUpload } from '@/lib/ingest';
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
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/**
 * PUT /api/jobs/:id/upload?kind=...&name=... - upload through the server.
 *
 * This is the development path. On Vercel a serverless function caps the
 * request body at about 4.5MB, which no video clip respects, so the browser
 * uploads clips straight to Blob instead and only tells the server about it
 * afterwards. Subtitles are tiny and always come through here.
 */
export async function PUT(request: Request, { params }: Params) {
  const { id } = await params;
  const found = await requireJob(id);
  if ('response' in found) return found.response;
  const job = found.job;

  const url = new URL(request.url);
  const kind = url.searchParams.get('kind');
  const rawName = url.searchParams.get('name') ?? '';

  if (!request.body) return fail('No file was sent.');
  if (kind !== 'clip' && kind !== 'voiceover' && kind !== 'subtitles') {
    return fail(`Unknown upload kind "${kind}".`);
  }

  const filename = safeFilename(rawName, `upload-${Date.now()}`);
  const ext = extensionOf(filename);
  const allowed =
    kind === 'clip' ? VIDEO_EXTENSIONS : kind === 'voiceover' ? AUDIO_EXTENSIONS : SUBTITLE_EXTENSIONS;

  if (ext && !allowed.has(ext)) {
    return fail(`"${filename}" is not a supported ${kind} file. Expected one of ${[...allowed].join(', ')}.`);
  }

  if (kind !== 'subtitles' && isServerless()) {
    return fail(
      'Large files must upload directly to Blob storage on this deployment. Reload the page so the browser uses the direct-upload path.',
    );
  }

  const scratch = scratchDir(id, `upload-${randomUUID()}`);

  try {
    await fsp.mkdir(scratch, { recursive: true });
    const local = path.join(scratch, filename);
    await pipeline(Readable.fromWeb(request.body as never), fs.createWriteStream(local));

    if (kind === 'subtitles') {
      await storage().putFile(keys.subtitles(id), local, 'text/plain');
      job.subtitles = { filename, cueCount: 0, wordCount: 0, durationMs: 0 };
      addLog(job, 'info', `Subtitles uploaded: ${filename}.`);
      await writeJob(job);
      return ok({ job });
    }

    const clipId = randomUUID();
    const key =
      kind === 'voiceover' ? keys.voiceover(id, ext || '.mp3') : keys.clip(id, clipId, ext || '.mp4');

    await storage().putFile(key, local, kind === 'voiceover' ? 'audio/mpeg' : 'video/mp4');

    const updated = await registerUpload(job, { kind, key, filename, clipId, localPath: local });
    await writeJob(updated);
    return ok({ job: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addLog(job, 'error', `Upload failed for ${filename}: ${message}`);
    await writeJob(job).catch(() => {});
    return fail(message, 500);
  } finally {
    await clearScratch(scratch);
  }
}

/** DELETE /api/jobs/:id/upload?clipId=... - remove one clip. */
export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params;
  const found = await requireJob(id);
  if ('response' in found) return found.response;
  const job: Job = found.job;

  const clipId = new URL(request.url).searchParams.get('clipId');
  const index = job.clips.findIndex((c) => c.id === clipId);
  if (index === -1) return fail('No such clip.', 404);

  const [removed] = job.clips.splice(index, 1);
  await storage().remove(removed.key).catch(() => {});
  await storage().remove(keys.thumb(id, removed.id)).catch(() => {});

  // The shot list referenced this clip, so it is no longer valid.
  job.shots = [];
  addLog(job, 'info', `Clip removed: ${removed.filename}.`);
  await writeJob(job);

  return ok({ job });
}
