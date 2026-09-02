import { renderStep } from '@/lib/render';
import { fail, ok, requireJob } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * 60s is the Hobby-plan ceiling. Pro allows 300 and Fluid up to 800; raising
 * this number and CLIPFORGE_STEP_BUDGET_MS together means fewer, longer steps.
 */
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/jobs/:id/render/step - do the next slice of the render.
 *
 * Encodes as many shots as fit in the time budget, records exactly where it
 * stopped, and returns. The client calls this in a loop until `more` is false.
 * Every step is resumable from the manifest alone, so it does not matter that
 * each one runs on a different instance with a different `/tmp`.
 */
export async function POST(_request: Request, { params }: Params) {
  const { id } = await params;
  const found = await requireJob(id);
  if ('response' in found) return found.response;
  const job = found.job;

  if (!job.render) return fail('This job has not started rendering.', 409);

  try {
    const result = await renderStep(job);
    return ok({ result });
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), 500);
  }
}
