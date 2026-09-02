import { z } from 'zod';
import { addLog, keys, writeJob } from '@/lib/jobs';
import { registerUpload } from '@/lib/ingest';
import { fail, ok, requireJob, safeFilename } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

const Body = z.object({
  kind: z.enum(['clip', 'voiceover']),
  key: z.string().min(1).max(300),
  filename: z.string().min(1).max(300),
  clipId: z.string().uuid().optional(),
});

/**
 * POST /api/jobs/:id/register - attach a directly-uploaded file to the job.
 *
 * The browser has already streamed the file to Blob; this probes it, records
 * its geometry and duration, and adds it to the manifest. Splitting upload from
 * registration is what lets the bytes bypass the function body limit while the
 * server still validates every file before it reaches the renderer.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const found = await requireJob(id);
  if ('response' in found) return found.response;
  const job = found.job;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch {
    return fail('Expected { kind, key, filename }.');
  }

  // The key was chosen by the client, so confirm it belongs to this job before
  // anything is recorded against it.
  if (!body.key.startsWith(keys.prefix(id))) {
    return fail('That file does not belong to this job.', 403);
  }

  // A repeated notification for a file already registered is a no-op, not an
  // error: the Blob webhook and the client can both call this.
  if (body.kind === 'clip' && job.clips.some((c) => c.key === body.key)) {
    return ok({ job });
  }

  try {
    const updated = await registerUpload(job, {
      kind: body.kind,
      key: body.key,
      filename: safeFilename(body.filename, 'upload'),
      clipId: body.clipId,
    });
    await writeJob(updated);
    return ok({ job: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addLog(job, 'error', message);
    await writeJob(job).catch(() => {});
    return fail(message, 500);
  }
}
