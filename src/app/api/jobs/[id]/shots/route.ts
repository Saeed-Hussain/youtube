import { z } from 'zod';
import { addLog, writeJob } from '@/lib/jobs';
import { fail, ok, requireJob } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const Body = z.object({
  shotIndex: z.number().int().min(0),
  clipId: z.string().min(1),
});

/**
 * PATCH /api/jobs/:id/shots - swap the clip used for one shot.
 *
 * The automatic plan is right most of the time, not all of the time. Letting
 * the user override a single shot without re-running anything is the
 * difference between a tool they can finish a video with and one they have to
 * fight. Only the source clip changes; timing is untouched, so an override can
 * never break sync.
 */
export async function PATCH(request: Request, { params }: Params) {
  const { id } = await params;
  const found = await requireJob(id);
  if ('response' in found) return found.response;
  const job = found.job;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch {
    return fail('Expected { shotIndex, clipId }.');
  }

  const shot = job.shots[body.shotIndex];
  if (!shot) return fail('No such shot.', 404);

  const clip = job.clips.find((c) => c.id === body.clipId);
  if (!clip) return fail('No such clip.', 404);

  shot.clipId = clip.id;
  shot.clipFilename = clip.filename;
  shot.reason = 'chosen by you';

  // Re-fit the in/out points to the new source: a shorter clip needs looping,
  // a longer one needs a window, and the shot duration must not move.
  if (clip.durationMs >= shot.durationMs) {
    shot.fitMode = 'trim';
    shot.loops = 1;
    shot.sourceInMs = 0;
    shot.sourceOutMs = shot.durationMs;
  } else if (clip.durationMs >= 400) {
    shot.fitMode = 'loop';
    shot.loops = Math.min(6, Math.ceil(shot.durationMs / clip.durationMs));
    shot.sourceInMs = 0;
    shot.sourceOutMs = clip.durationMs;
  } else {
    shot.fitMode = 'stretch';
    shot.loops = 1;
    shot.sourceInMs = 0;
    shot.sourceOutMs = clip.durationMs;
  }

  addLog(job, 'info', `Shot ${body.shotIndex + 1} set to ${clip.filename}.`);
  await writeJob(job);

  return ok({ job });
}
