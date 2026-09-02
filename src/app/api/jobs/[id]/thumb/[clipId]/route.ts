import fsp from 'node:fs/promises';
import { isValidJobId, jobPath } from '@/lib/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string; clipId: string }> };

/** GET /api/jobs/:id/thumb/:clipId - the poster frame for one clip. */
export async function GET(_request: Request, { params }: Params) {
  const { id, clipId } = await params;

  // Both ids are UUIDs we generated. Validating the shape is what stops a
  // crafted clipId from walking out of the thumbs directory.
  if (!isValidJobId(id) || !isValidJobId(clipId)) {
    return new Response('Not found', { status: 404 });
  }

  const file = jobPath(id, 'thumbs', `${clipId}.jpg`);
  const data = await fsp.readFile(file).catch(() => null);
  if (!data) return new Response('Not found', { status: 404 });

  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': 'image/jpeg',
      // Thumbnails never change once written, and the job id scopes the URL.
      'Cache-Control': 'private, max-age=86400, immutable',
    },
  });
}
