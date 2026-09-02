import { z } from 'zod';
import { analyseJob } from '@/lib/pipeline';
import { addLog, writeJob } from '@/lib/jobs';
import { fail, ok, requireJob } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

const Settings = z.object({
  declaredNames: z.array(z.string().max(80)).max(60).optional(),
  minNamedMs: z.number().int().min(200).max(10_000).optional(),
  minBrollMs: z.number().int().min(400).max(20_000).optional(),
  maxDurationMs: z.number().int().min(1000).max(60_000).optional(),
  carryForward: z.boolean().optional(),
  carryForwardMs: z.number().int().min(0).max(60_000).optional(),
});

/**
 * POST /api/jobs/:id/analyse
 *
 * Parses the SRT, discovers the cast, and produces the shot list. Cheap enough
 * to re-run on every settings change, which is why the UI treats it as live
 * rather than as a pipeline step to be committed to.
 */
export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const found = await requireJob(id);
  if ('response' in found) return found.response;
  const job = found.job;

  let settings: z.infer<typeof Settings> = {};
  try {
    const body = await request.json().catch(() => ({}));
    settings = Settings.parse(body ?? {});
  } catch (err) {
    return fail(err instanceof z.ZodError ? err.issues[0]?.message ?? 'Invalid settings.' : 'Invalid settings.');
  }

  if (settings.minBrollMs && settings.maxDurationMs && settings.minBrollMs >= settings.maxDurationMs) {
    return fail('The shortest b-roll shot must be shorter than the longest shot.');
  }
  if (settings.minNamedMs && settings.minBrollMs && settings.minNamedMs > settings.minBrollMs) {
    return fail('Name-driven cuts cannot have a higher floor than b-roll shots.');
  }

  if (!job.subtitles) return fail('Upload a subtitle file first.');
  if (!job.clips.length) return fail('Upload at least one clip first.');

  try {
    job.progress = { stage: 'analysing', percent: 10, label: 'Reading subtitles' };
    await writeJob(job);

    const updated = await analyseJob(job, settings);
    return ok({ job: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    job.progress = { stage: 'failed', percent: 0, label: 'Analysis failed' };
    job.error = message;
    addLog(job, 'error', message);
    await writeJob(job);
    return fail(message, 500);
  }
}
