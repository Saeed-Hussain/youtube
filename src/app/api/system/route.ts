import os from 'node:os';
import { detectBestEncoder, ffmpegPath, renderConcurrency, run } from '@/lib/ffmpeg';
import { checkStorage } from '@/lib/jobs';
import { ok } from '@/lib/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/system - what this machine can do.
 *
 * Surfaced in the UI so a missing FFmpeg is a clear message on first load
 * rather than a cryptic failure at render time, and so the user can see
 * whether hardware encoding was found.
 */
export async function GET() {
  // Storage is checked independently of FFmpeg: a host can fail either, and the
  // user needs to know which.
  const storage = await checkStorage();

  try {
    const bin = await ffmpegPath();
    const { stderr, stdout } = await run(bin, ['-version']).catch((e) => ({
      stdout: '',
      stderr: String(e),
    }));
    const version = (stdout || stderr).split('\n')[0] ?? 'unknown';
    const encoder = await detectBestEncoder();

    return ok({
      ready: storage.writable,
      storageWritable: storage.writable,
      storageError: storage.error,
      storageKind: storage.kind,
      ffmpeg: version.trim(),
      encoder,
      hardwareAccelerated: encoder !== 'x264',
      cores: os.cpus()?.length ?? 0,
      concurrency: renderConcurrency(),
    });
  } catch (err) {
    return ok({
      ready: false,
      storageWritable: storage.writable,
      storageError: storage.error,
      storageKind: storage.kind,
      error: err instanceof Error ? err.message : String(err),
      cores: os.cpus()?.length ?? 0,
    });
  }
}
