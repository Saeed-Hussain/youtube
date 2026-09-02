import { deleteJob } from '@/lib/jobs';
import { ok, requireJob } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/jobs/:id - the full job manifest.
 *
 * This doubles as the progress endpoint. Polling a small JSON file beats an
 * SSE stream here because a render can outlive the connection (and any
 * proxy's idle timeout), and the manifest is written atomically, so a poll can
 * never observe a half-updated state.
 */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  const found = await requireJob(id);
  if ('response' in found) return found.response;

  return ok({ job: found.job, rendering: found.job.progress.stage === 'rendering' });
}

/** DELETE /api/jobs/:id - remove the job and everything it uploaded. */
export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  await deleteJob(id);
  return ok({ deleted: true });
}
