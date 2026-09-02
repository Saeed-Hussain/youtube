import { createJob, listJobs, pruneOldJobs } from '@/lib/jobs';
import { ok } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/jobs - recent jobs, newest first. */
export async function GET() {
  const jobs = await listJobs();
  return ok({
    jobs: jobs.slice(0, 20).map((j) => ({
      id: j.id,
      createdAt: j.createdAt,
      stage: j.progress.stage,
      clipCount: j.clips.length,
      shotCount: j.shots.length,
      hasOutput: Boolean(j.output),
    })),
  });
}

/** POST /api/jobs - start a new job. */
export async function POST() {
  // Old jobs hold gigabytes of video. Prune here rather than on a timer so
  // there is no background process to supervise.
  await pruneOldJobs(24).catch(() => 0);
  const job = await createJob();
  return ok({ job });
}
