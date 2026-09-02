import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ key: string[] }> };

/**
 * GET /api/files/<key> - serve an object from local storage.
 *
 * Only used by the filesystem backend, in development. On Vercel the storage
 * adapter hands out Blob URLs and the browser fetches them directly from the
 * CDN, which is both faster and avoids routing hundreds of megabytes of video
 * through a serverless function.
 *
 * Range requests are honoured so the in-page player can seek.
 */
export async function GET(request: Request, { params }: Params) {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    return new Response('Not found', { status: 404 });
  }

  const { key } = await params;
  const root = path.resolve(process.env.CLIPFORGE_DATA ?? path.join(process.cwd(), '.data'));
  const target = path.resolve(root, key.join('/'));

  // The key comes from the URL, so a traversal attempt has to be rejected
  // rather than trusted.
  if (!target.startsWith(root + path.sep)) {
    return new Response('Not found', { status: 404 });
  }

  const stat = await fsp.stat(target).catch(() => null);
  if (!stat?.isFile()) return new Response('Not found', { status: 404 });

  const type = contentType(target);
  const base: Record<string, string> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };

  const match = request.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/);
  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
    if (!Number.isFinite(start) || start > end || start >= stat.size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
    }
    return new Response(Readable.toWeb(fs.createReadStream(target, { start, end })) as ReadableStream, {
      status: 206,
      headers: {
        ...base,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': String(end - start + 1),
      },
    });
  }

  return new Response(Readable.toWeb(fs.createReadStream(target)) as ReadableStream, {
    headers: { ...base, 'Content-Length': String(stat.size) },
  });
}

function contentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.json') return 'application/json';
  if (ext === '.srt' || ext === '.vtt') return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
