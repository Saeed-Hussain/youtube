import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';

import { jobPath } from '@/lib/jobs';
import { fail, requireJob } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/jobs/:id/download - stream the finished MP4.
 *
 * Range requests are honoured so the in-page `<video>` element can seek without
 * pulling the whole file, which matters when the output is several hundred
 * megabytes. The body is a stream either way, never a buffer.
 */
export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  const found = await requireJob(id);
  if ('response' in found) return found.response;
  const job = found.job;

  if (!job.output) return fail('This job has not produced a video yet.', 404);

  const file = jobPath(id, job.output.filename);
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) return fail('The rendered file is gone - it may have been pruned. Render again.', 404);

  const download = new URL(request.url).searchParams.get('download') === '1';
  const suggested = `clipforge-${id.slice(0, 8)}.mp4`;

  const baseHeaders: Record<string, string> = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    ...(download ? { 'Content-Disposition': `attachment; filename="${suggested}"` } : {}),
  };

  const range = request.headers.get('range');
  const match = range?.match(/^bytes=(\d*)-(\d*)$/);

  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;

    if (!Number.isFinite(start) || start > end || start >= stat.size) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${stat.size}` },
      });
    }

    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': String(end - start + 1),
      },
    });
  }

  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return new Response(stream, {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(stat.size) },
  });
}
