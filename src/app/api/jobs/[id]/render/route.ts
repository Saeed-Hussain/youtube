import { z } from 'zod';
import { startRender } from '@/lib/render';
import { addLog, writeJob, writeProgress } from '@/lib/jobs';
import { fail, ok, requireJob } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Params = { params: Promise<{ id: string }> };

const Profile = z.object({
  width: z.number().int().min(256).max(3840).optional(),
  height: z.number().int().min(144).max(2160).optional(),
  fps: z.number().int().min(12).max(60).optional(),
  quality: z.number().int().min(14).max(35).optional(),
  encoder: z.enum(['auto', 'x264', 'nvenc', 'qsv', 'amf', 'videotoolbox']).optional(),
  audioBitrate: z.enum(['128k', '160k', '192k', '256k', '320k']).optional(),
  fill: z.enum(['pad', 'crop']).optional(),
});

/**
 * POST /api/jobs/:id/render - begin a render.
 *
 * Only sets up state: normalises the voiceover, picks the encoder and works out
 * the frame budget. The encoding itself happens in `/render/step`, which the
 * client calls repeatedly, because no single serverless invocation lives long
 * enough to render a video.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const found = await requireJob(id);
  if ('response' in found) return found.response;
  const job = found.job;

  if (!job.shots.length) return fail('Run the analysis before rendering.');

  let profile: z.infer<typeof Profile> = {};
  try {
    profile = Profile.parse((await request.json().catch(() => ({}))) ?? {});
  } catch {
    return fail('Invalid render settings.');
  }

  job.profile = { ...job.profile, ...stripUndefined(profile) };
  addLog(job, 'info', `Render queued at ${job.profile.width}x${job.profile.height} ${job.profile.fps}fps.`);

  try {
    await startRender(job);
    return ok({ job });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    job.progress = { stage: 'failed', percent: 0, label: 'Render failed' };
    job.error = message;
    addLog(job, 'error', message);
    await writeJob(job);
    await writeProgress(job, false);
    return fail(message, 500);
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
