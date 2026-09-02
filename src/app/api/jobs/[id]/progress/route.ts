import { readProgress, readJob, isValidJobId } from '@/lib/jobs';
import { fail, ok } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/jobs/:id/progress - just the render progress.
 *
 * The client polls this several times a second while a render runs. Serving it
 * from the manifest would ship the entire shot list on every poll - about
 * 150KB for a 23-minute video, several hundred KB/s for two numbers - and force
 * a full re-render of every panel in the UI. This reads a ~200 byte sidecar
 * instead, and carries a `revision` so the client knows when the full job is
 * actually worth refetching.
 */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  if (!isValidJobId(id)) return fail('Unknown job.', 404);

  const snapshot = await readProgress(id);
  if (snapshot) return ok({ progress: snapshot });

  // No sidecar yet - this job has never rendered. Fall back to the manifest so
  // the caller still gets a truthful answer rather than a 404.
  const job = await readJob(id);
  if (!job) return fail('That job no longer exists. Start a new one.', 404);

  return ok({
    progress: { ...job.progress, updatedAt: job.updatedAt, error: job.error, revision: job.updatedAt },
  });
}
