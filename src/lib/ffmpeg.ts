import { spawn } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

export interface MediaInfo {
  durationMs: number;
  width: number;
  height: number;
  fps: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
}

export class FFmpegError extends Error {
  readonly command: string;
  readonly stderr: string;

  constructor(message: string, command: string, stderr: string) {
    super(message);
    this.name = 'FFmpegError';
    this.command = command;
    this.stderr = stderr;
  }
}

/* ------------------------------------------------------------------ */
/* binaries                                                            */
/* ------------------------------------------------------------------ */

let cachedFfmpeg: string | null = null;
let cachedFfprobe: string | null = null;

/**
 * Locate the ffmpeg binary.
 *
 * A native binary is the entire reason this rewrite renders in seconds rather
 * than minutes: ffmpeg.wasm runs the same encoder inside WebAssembly with no
 * SIMD-tuned assembly and no multi-process parallelism, which costs roughly an
 * order of magnitude. FFMPEG_PATH lets a deployment pin a specific build;
 * otherwise we take whatever is on PATH.
 */
export async function ffmpegPath(): Promise<string> {
  if (cachedFfmpeg) return cachedFfmpeg;
  cachedFfmpeg = await resolveBinary('ffmpeg', process.env.FFMPEG_PATH);
  return cachedFfmpeg;
}

export async function ffprobePath(): Promise<string> {
  if (cachedFfprobe) return cachedFfprobe;
  cachedFfprobe = await resolveBinary('ffprobe', process.env.FFPROBE_PATH);
  return cachedFfprobe;
}

async function resolveBinary(name: string, override?: string): Promise<string> {
  // An override first, then whatever is on PATH. There is deliberately no
  // bundled-binary fallback: importing an optional package that is not in
  // package.json makes the bundler emit an unresolvable module and fail the
  // production build, and a 70MB vendored binary is the wrong default for a
  // tool that needs a full FFmpeg build anyway.
  const candidates = [override, name].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const proc = spawn(candidate, ['-version'], { stdio: 'ignore' });
      const [code] = (await once(proc, 'close')) as [number];
      if (code === 0) return candidate;
    } catch {
      /* try the next one */
    }
  }

  throw new Error(
    `Could not find "${name}". Install FFmpeg and make sure it is on your PATH, or set ${name.toUpperCase()}_PATH to its full path.`,
  );
}

/* ------------------------------------------------------------------ */
/* probing                                                             */
/* ------------------------------------------------------------------ */

/** Read duration, resolution and frame rate out of a media file. */
export async function probe(file: string): Promise<MediaInfo> {
  const bin = await ffprobePath();
  const { stdout } = await run(bin, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ]);

  let parsed: any;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`ffprobe returned unreadable output for ${path.basename(file)}.`);
  }

  const streams: any[] = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  // Prefer the container duration; fall back to the stream's, since some
  // fragmented MP4s and raw streams only carry it in one place.
  const durationSec =
    Number(parsed.format?.duration) ||
    Number(video?.duration) ||
    Number(audio?.duration) ||
    0;

  return {
    durationMs: Math.round(durationSec * 1000),
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
    fps: parseRational(video?.avg_frame_rate) || parseRational(video?.r_frame_rate) || 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
  };
}

function parseRational(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const [num, den] = value.split('/').map(Number);
  if (!den) return Number.isFinite(num) ? num : 0;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : 0;
}

/** Grab a still from the middle of a clip, for the clip list in the UI. */
export async function makeThumbnail(source: string, dest: string, atMs: number): Promise<void> {
  const bin = await ffmpegPath();
  await run(bin, [
    '-y',
    '-ss', (Math.max(0, atMs) / 1000).toFixed(3),
    '-i', source,
    '-frames:v', '1',
    '-vf', 'scale=320:-2',
    '-q:v', '4',
    dest,
  ]);
}

/* ------------------------------------------------------------------ */
/* encoder selection                                                   */
/* ------------------------------------------------------------------ */

export type EncoderChoice = 'auto' | 'x264' | 'nvenc' | 'qsv' | 'amf' | 'videotoolbox';

interface EncoderSpec {
  name: string;
  args: string[];
}

export type HardwareEncoder = Exclude<EncoderChoice, 'auto'>;

let encoderProbe: Promise<HardwareEncoder> | null = null;

/**
 * Pick a video encoder, verifying the hardware one actually works.
 *
 * Listing an encoder in `ffmpeg -encoders` only means the build has support
 * compiled in - h264_nvenc is present on every gyan.dev build whether or not
 * there is an NVIDIA card in the machine. So the check is an actual one-frame
 * encode: cheap, and the only answer that does not fail halfway through a
 * 20-minute render.
 */
export async function detectBestEncoder(): Promise<HardwareEncoder> {
  encoderProbe ??= (async () => {
    const bin = await ffmpegPath();
    const { stdout } = await run(bin, ['-hide_banner', '-encoders']).catch(() => ({ stdout: '' }));

    const order: [HardwareEncoder, string][] = [
      ['nvenc', 'h264_nvenc'],
      ['qsv', 'h264_qsv'],
      ['videotoolbox', 'h264_videotoolbox'],
      ['amf', 'h264_amf'],
    ];

    for (const [choice, encoder] of order) {
      if (!stdout.includes(encoder)) continue;
      const ok = await run(bin, [
        '-v', 'error',
        '-f', 'lavfi',
        '-i', 'testsrc=size=320x240:rate=1',
        '-frames:v', '1',
        '-c:v', encoder,
        '-f', 'null',
        '-',
      ])
        .then(() => true)
        .catch(() => false);
      if (ok) return choice;
    }

    return 'x264';
  })();

  return encoderProbe;
}

function encoderSpec(choice: HardwareEncoder, fps: number, quality: number): EncoderSpec {
  // A closed GOP of one second with no scene-cut detection is what makes the
  // concat-copy stage legal: every segment starts on a keyframe, so the pieces
  // join without re-encoding.
  const gop = ['-g', String(Math.max(1, Math.round(fps))), '-keyint_min', String(Math.max(1, Math.round(fps)))];

  switch (choice) {
    case 'nvenc':
      return { name: 'h264_nvenc', args: [...gop, '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', String(quality), '-b:v', '0', '-bf', '0'] };
    case 'qsv':
      return { name: 'h264_qsv', args: [...gop, '-preset', 'faster', '-global_quality', String(quality), '-bf', '0'] };
    case 'amf':
      return { name: 'h264_amf', args: [...gop, '-quality', 'speed', '-rc', 'cqp', '-qp_i', String(quality), '-qp_p', String(quality), '-bf', '0'] };
    case 'videotoolbox':
      return { name: 'h264_videotoolbox', args: [...gop, '-q:v', String(quality)] };
    case 'x264':
    default:
      return {
        name: 'libx264',
        args: [
          ...gop,
          '-preset', 'veryfast',
          '-crf', String(quality),
          '-sc_threshold', '0',
          // No B-frames: they complicate the timestamps that the concat
          // demuxer has to splice, for a negligible size win at this preset.
          '-bf', '0',
        ],
      };
  }
}

/* ------------------------------------------------------------------ */
/* process helpers                                                     */
/* ------------------------------------------------------------------ */

export interface RunResult {
  stdout: string;
  stderr: string;
}

export async function run(bin: string, args: string[], onLine?: (line: string) => void): Promise<RunResult> {
  const proc = spawn(bin, args, { windowsHide: true });

  let stdout = '';
  let stderr = '';
  let tail = '';

  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');

  proc.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (!onLine) return;
    tail += chunk;
    const lines = tail.split(/\r?\n/);
    tail = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  });

  proc.stderr.on('data', (chunk: string) => {
    // Keep the tail only: a failing ffmpeg can emit megabytes, and only the
    // last few hundred lines ever say why.
    stderr = (stderr + chunk).slice(-64_000);
  });

  const [code] = (await once(proc, 'close')) as [number | null];

  if (code !== 0) {
    throw new FFmpegError(
      `ffmpeg exited with code ${code}: ${lastMeaningfulLine(stderr)}`,
      `${bin} ${args.join(' ')}`,
      stderr,
    );
  }

  return { stdout, stderr };
}

function lastMeaningfulLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/).filter((l) => l.trim() && !/^\s*(?:frame|size)=/.test(l));
  return lines[lines.length - 1] ?? 'no error output';
}

/* ------------------------------------------------------------------ */
/* frame maths                                                         */
/* ------------------------------------------------------------------ */

/**
 * Convert a millisecond timeline into whole frames without accumulating drift.
 *
 * This is the fix for the single worst bug in the old renderer. Asking ffmpeg
 * for `-t 3.417` gives you however many frames fit in 3.417s, rounded; do that
 * 400 times and the rounding errors add up to seconds of desync by the end of
 * the video.
 *
 * Instead each boundary is rounded to an absolute frame number, and a shot's
 * length is the *difference* between two absolute frame numbers. The errors
 * telescope away: the sum of all shot lengths is exactly the frame number of
 * the final boundary, so the video is always precisely as long as the
 * voiceover, no matter how many cuts it has.
 */
export function frameSpans(boundariesMs: number[], fps: number): number[] {
  const frames = boundariesMs.map((ms) => Math.round((ms / 1000) * fps));
  const spans: number[] = [];
  for (let i = 0; i < frames.length - 1; i++) {
    spans.push(Math.max(1, frames[i + 1] - frames[i]));
  }
  return spans;
}

/* ------------------------------------------------------------------ */
/* segment rendering                                                   */
/* ------------------------------------------------------------------ */

export interface RenderProfile {
  width: number;
  height: number;
  fps: number;
  /** CRF/CQ - lower is better quality. 18-28 is the useful range. */
  quality: number;
  encoder: EncoderChoice;
  audioBitrate: string;
  /** How to handle a clip whose aspect ratio differs from the output. */
  fill: 'pad' | 'crop';
}

export const DEFAULT_PROFILE: RenderProfile = {
  width: 1920,
  height: 1080,
  fps: 30,
  quality: 21,
  encoder: 'auto',
  audioBitrate: '192k',
  fill: 'pad',
};

export interface SegmentJob {
  index: number;
  sourcePath: string;
  /** The source's real geometry, so filters that would be no-ops can be dropped. */
  sourceWidth: number;
  sourceHeight: number;
  sourceFps: number;
  /** Seek point inside the source, in ms. */
  sourceInMs: number;
  /** Exact number of output frames. Non-negotiable - this is the sync anchor. */
  frames: number;
  /** Loop the source this many times before trimming. */
  loops: number;
  /** Speed factor applied to the source; 1 = untouched. */
  speed: number;
  outputPath: string;
}

/**
 * Build the filter chain for one shot, skipping every stage that would be a
 * no-op for this particular source.
 *
 * The common case is a library of clips already at the output resolution and
 * frame rate. Running them through scale, pad and fps anyway pushes every frame
 * through swscale and the fps reorderer for no change in the picture, which is
 * pure cost on the hottest path in the program. Comparing against the probed
 * geometry lets those clips reduce to a bare pixel-format conversion.
 */
function buildFilterChain(job: SegmentJob, profile: RenderProfile): string {
  const chain: string[] = [];

  if (job.speed !== 1) chain.push(`setpts=${(1 / job.speed).toFixed(6)}*PTS`);

  const geometryMatches = job.sourceWidth === profile.width && job.sourceHeight === profile.height;
  if (!geometryMatches) {
    chain.push(
      profile.fill === 'crop'
        ? // Fill the frame and cut the overflow - no bars, some content lost.
          `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=increase,crop=${profile.width}:${profile.height}`
        : // Fit inside the frame and letterbox the remainder - nothing lost.
          `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    );
  }

  // setsar is effectively free and guards against a source with non-square
  // pixels, which would otherwise concatenate at the wrong shape.
  chain.push('setsar=1');

  // Retiming is unavoidable once the clip has been sped up or slowed down.
  const fpsMatches = job.speed === 1 && Math.abs(job.sourceFps - profile.fps) < 0.01;
  if (!fpsMatches) chain.push(`fps=${profile.fps}`);

  chain.push('format=yuv420p');
  return chain.join(',');
}

/**
 * Render one shot to a normalised intermediate file.
 *
 * Every intermediate comes out with identical codec, resolution, pixel format,
 * frame rate, timebase and GOP structure. That uniformity is what lets the
 * final assembly be a stream copy - the expensive encoding happens here, in
 * parallel across cores, instead of once through a single serial filter graph.
 */
export async function renderSegment(job: SegmentJob, profile: RenderProfile, encoder: HardwareEncoder): Promise<void> {
  const bin = await ffmpegPath();
  const spec = encoderSpec(encoder, profile.fps, profile.quality);

  const args: string[] = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error'];

  // -stream_loop must precede -i. Seeking before -i is both fast (ffmpeg jumps
  // to the nearest preceding keyframe) and accurate (it decodes forward to the
  // exact requested time before the filter chain sees a frame).
  if (job.loops > 1) args.push('-stream_loop', String(job.loops - 1));
  if (job.sourceInMs > 0) args.push('-ss', (job.sourceInMs / 1000).toFixed(3));
  args.push('-i', job.sourcePath);

  args.push(
    '-an', // audio comes from the voiceover, never from the clips
    '-vf', buildFilterChain(job, profile),
    // Shots are encoded several at a time. Left alone, every libx264 process
    // spawns one thread per core, so N processes fight over N*cores threads and
    // lose real time to context switching. Dividing the cores between the
    // workers keeps them cooperating instead of competing.
    '-threads', String(encoderThreads()),
    // The frame count - not a duration - is what guarantees zero drift.
    '-frames:v', String(job.frames),
    '-c:v', spec.name,
    ...spec.args,
    '-pix_fmt', 'yuv420p',
    // A single fixed timescale across every intermediate keeps the concat
    // demuxer from having to rewrite timestamps.
    '-video_track_timescale', '90000',
    '-fflags', '+genpts',
    '-avoid_negative_ts', 'make_zero',
    '-movflags', '+faststart',
    job.outputPath,
  );

  await run(bin, args);
}

/**
 * Splice the intermediates together and lay the voiceover over the top.
 *
 * Both streams are stream-copied, so this step is I/O bound and finishes in
 * about the time it takes to write the file - regardless of whether the video
 * is two minutes or two hours.
 */
export async function concatSegments(
  segmentPaths: string[],
  audioPath: string | null,
  outputPath: string,
  profile: RenderProfile,
  workDir: string,
  onProgress?: (processedMs: number) => void,
): Promise<void> {
  const bin = await ffmpegPath();
  const listPath = path.join(workDir, 'concat.txt');

  // The concat demuxer treats the list as a mini-script: single quotes must be
  // escaped, and paths are resolved relative to the list file unless absolute.
  const list = segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  await fs.writeFile(listPath, `${list}\n`, 'utf8');

  const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-f', 'concat', '-safe', '0', '-i', listPath];

  if (audioPath) {
    args.push('-i', audioPath, '-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', profile.audioBitrate, '-ar', '48000');
  } else {
    args.push('-map', '0:v:0');
  }

  args.push('-c:v', 'copy', '-movflags', '+faststart', outputPath);

  await run(bin, args, (line) => {
    if (!onProgress) return;
    const m = line.match(/^out_time_ms=(\d+)/);
    if (m) onProgress(Number(m[1]) / 1000);
  });
}

/** Normalise the voiceover to a single predictable audio file up front. */
export async function prepareAudio(source: string, dest: string, profile: RenderProfile): Promise<number> {
  const bin = await ffmpegPath();
  await run(bin, [
    '-y', '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-i', source,
    '-vn',
    '-c:a', 'aac',
    '-b:a', profile.audioBitrate,
    '-ar', '48000',
    '-ac', '2',
    dest,
  ]);
  const info = await probe(dest);
  return info.durationMs;
}

/** Sensible parallelism: leave a core for the OS and the Next.js process. */
export function renderConcurrency(): number {
  const cores = os.cpus()?.length ?? 4;
  return Math.max(1, Math.min(8, cores - 1));
}

/** Threads per encoder process, so parallel workers do not oversubscribe. */
export function encoderThreads(): number {
  const cores = os.cpus()?.length ?? 4;
  return Math.max(1, Math.floor(cores / renderConcurrency()));
}
