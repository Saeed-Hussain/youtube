import { z } from 'zod';
import { addLog, writeJob } from '@/lib/jobs';
import { fail, ok, requireJob } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string; clipId: string }> };

const Body = z.object({
  tags: z.array(z.string().max(60)).max(20),
});

/**
 * PATCH /api/jobs/:id/clips/:clipId - retag a clip.
 *
 * Tags are what bind a clip to a character. Changing them invalidates the shot
 * list, so it is cleared here; the UI re-runs the analysis immediately after,
 * which is fast enough to feel instant.
 */
export async function PATCH(request: Request, { params }: Params) {
  const { id, clipId } = await params;
  const found = await requireJob(id);
  if ('response' in found) return found.response;
  const job = found.job;

  const clip = job.clips.find((c) => c.id === clipId);
  if (!clip) return fail('No such clip.', 404);

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch {
    return fail('Expected a "tags" array of strings.');
  }

  clip.tags = [...new Set(body.tags.map((t) => t.trim()).filter(Boolean))];
  job.shots = [];
  addLog(job, 'info', `Retagged ${clip.filename}: ${clip.tags.join(', ') || '(no tags)'}.`);
  await writeJob(job);

  return ok({ job });
}
