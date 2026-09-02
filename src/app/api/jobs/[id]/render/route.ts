import { z } from 'zod';
import { isRendering, renderJob } from '@/lib/pipeline';
import { addLog, writeJob } from '@/lib/jobs';
import { fail, ok, requireJob } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 3600;

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
 * POST /api/jobs/:id/render
 *
 * Kicks the render off and returns immediately. The render outlives the
 * request on purpose: a 20-minute video takes longer than any sensible HTTP
 * timeout, and progress is already durable in `job.json`, so the client polls
 * for it instead of holding a connection open.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const found = await requireJob(id);
  if ('response' in found) return found.response;
  const job = found.job;

  if (isRendering(id)) return fail('This job is already rendering.', 409);
  if (!job.shots.length) return fail('Run the analysis before rendering.');

  let profile: z.infer<typeof Profile> = {};
  try {
    profile = Profile.parse((await request.json().catch(() => ({}))) ?? {});
  } catch {
    return fail('Invalid render settings.');
  }

  job.profile = { ...job.profile, ...stripUndefined(profile) };
  job.output = null;
  job.error = null;
  job.progress = { stage: 'rendering', percent: 0, label: 'Starting' };
  addLog(job, 'info', `Render queued at ${job.profile.width}x${job.profile.height} ${job.profile.fps}fps.`);
  await writeJob(job);

  // Deliberately not awaited. Failures are recorded on the job by renderJob's
  // own error path, so the catch here only exists to keep the rejection from
  // becoming an unhandled promise.
  void renderJob(job).catch(() => {});

  return ok({ started: true, job });
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
