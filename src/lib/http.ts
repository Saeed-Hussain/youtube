import { NextResponse } from 'next/server';
import { readJob, type Job } from './jobs.ts';

/** Consistent JSON error shape so the client only has one thing to parse. */
export function fail(message: string, status = 400): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export function ok<T extends object>(data: T): NextResponse {
  return NextResponse.json({ ok: true, ...data });
}

/** Load a job, or hand back the 404 response for you. */
export async function requireJob(id: string): Promise<{ job: Job } | { response: NextResponse }> {
  const job = await readJob(id);
  if (!job) return { response: fail('That job no longer exists. Start a new one.', 404) };
  return { job };
}

/**
 * Make an uploaded filename safe to join onto a path.
 *
 * Uploads name their own file, so this assumes the name is hostile: take only
 * the last path component (killing both `../` traversal and absolute paths),
 * drop control characters and the bytes Windows forbids, and cap the length.
 */
export function safeFilename(raw: string, fallback: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';

  let cleaned = '';
  for (const ch of base) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue; // control characters
    if ('<>:"|?*'.includes(ch)) {
      cleaned += '_';
      continue;
    }
    cleaned += ch;
  }

  cleaned = cleaned.replace(/^\.+/, '').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  if (cleaned.length > 120) return `${cleaned.slice(0, 100)}${extensionOf(cleaned)}`;
  return cleaned;
}

export function extensionOf(name: string): string {
  const m = name.match(/(\.[a-z0-9]{1,8})$/i);
  return m ? m[1].toLowerCase() : '';
}

export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mpg', '.mpeg', '.wmv', '.flv', '.ts',
]);
export const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.opus', '.flac', '.wma',
]);
export const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt', '.txt']);
