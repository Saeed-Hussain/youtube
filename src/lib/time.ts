/**
 * All timing in this codebase is integer milliseconds.
 *
 * Floating-point seconds were the source of the old renderer's drift: adding
 * 400 clip durations as floats accumulates error, and ffmpeg's `-ss`/`-t`
 * accept only 3-decimal precision anyway. Integers make the arithmetic exact
 * and make "does the video length equal the audio length" a `===` check.
 */
export type Ms = number;

/** `00:01:23,456` / `00:01:23.456` / `1:23.4` → ms. Returns null if unparseable. */
export function parseTimestamp(raw: string): Ms | null {
  const m = raw.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?$/);
  if (!m) return null;
  const [, h, min, s, frac] = m;
  // "1,5" means 500ms, not 5ms — pad right, not left.
  const ms = frac ? Number(frac.padEnd(3, '0')) : 0;
  return (Number(h ?? 0) * 3600 + Number(min) * 60 + Number(s)) * 1000 + ms;
}

/** ms → `00:01:23.456`, the form ffmpeg accepts for -ss/-t/-to. */
export function formatFFmpegTime(ms: Ms): string {
  const sign = ms < 0 ? '-' : '';
  const t = Math.max(0, Math.round(Math.abs(ms)));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const f = t % 1000;
  return `${sign}${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(f, 3)}`;
}

/** ms → `1:23` or `1:02:03`, for the UI. */
export function formatClock(ms: Ms): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  return h > 0 ? `${h}:${pad(m, 2)}:${pad(s, 2)}` : `${m}:${pad(s, 2)}`;
}

/** ms → seconds with 3 decimals, as a number. */
export function toSeconds(ms: Ms): number {
  return Math.round(ms) / 1000;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}
