/**
 * End-to-end check against a running server.
 *
 *   node tests/e2e/make-media.mjs      # generate colour-coded fixtures
 *   npm run build && npm start -- -p 3111
 *   node tests/e2e/run.mjs
 *
 * Each fixture clip is a single flat colour, so sampling the centre pixel of a
 * rendered frame says exactly which source clip was on screen at that instant.
 * That turns "did every clip land in the right place" into an assertion rather
 * than something you have to watch the video to check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = process.env.CLIPFORGE_URL ?? 'http://localhost:3111';
const MEDIA = path.join(import.meta.dirname, 'media');
const OUT_DIR = import.meta.dirname;

const j = async (res) => {
  const b = await res.json();
  if (!b.ok) throw new Error(b.error);
  return b;
};

const upload = async (id, kind, file) =>
  j(
    await fetch(`${BASE}/api/jobs/${id}/upload?kind=${kind}&name=${encodeURIComponent(file)}`, {
      method: 'PUT',
      body: fs.readFileSync(path.join(MEDIA, file)),
      duplex: 'half',
    }),
  );

const post = async (url, body) =>
  j(await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }));

// --- 1. create + upload ----------------------------------------------------
const { job: created } = await j(await fetch(`${BASE}/api/jobs`, { method: 'POST' }));
const id = created.id;
console.log('job', id);

console.time('upload');
await upload(id, 'subtitles', 'test.srt');
await upload(id, 'voiceover', 'voice.m4a');
for (const clip of ['drake_court_01.mp4', 'drake_stage.mp4', 'kendrik_superbowl.mp4', 'umg_building.mp4', 'faisal_desk.mp4', 'city_broll.mp4']) {
  await upload(id, 'clip', clip);
}
console.timeEnd('upload');

// --- 2. analyse ------------------------------------------------------------
console.time('analyse');
const { job: analysed } = await post(`/api/jobs/${id}/analyse`, { minNamedMs: 600, minBrollMs: 2000, maxDurationMs: 7000, carryForward: true });
console.timeEnd('analyse');

console.log('\nCAST:');
for (const e of analysed.entities) {
  const clips = analysed.clips.filter((c) => c.entityIds.includes(e.id)).map((c) => c.filename);
  console.log(`  ${e.canonical.padEnd(24)} ${String(e.mentionCount).padStart(2)} mentions  clips: ${clips.join(', ') || '(none)'}`);
}

console.log('\nSHOTS:');
for (const s of analysed.shots) {
  console.log(
    `  ${String(s.startMs).padStart(6)}-${String(s.endMs).padStart(6)}  ${String(s.durationMs).padStart(5)}ms  ${(s.entityName ?? '-').padEnd(22)} ${s.clipFilename.padEnd(24)} ${s.fitMode}`,
  );
}

// --- 3. render, one step at a time -----------------------------------------
// This mirrors exactly what the browser does. The render is a chain of short
// calls rather than one long one, so no single request has to outlive a
// serverless function's time limit.
console.log('');
console.log('rendering...');
const t0 = Date.now();
await post(`/api/jobs/${id}/render`, { width: 1920, height: 1080, fps: 30, quality: 21, fill: 'pad' });

let steps = 0;
let failure = null;
for (;;) {
  const { result } = await post(`/api/jobs/${id}/render/step`);
  steps++;
  console.log(`  step ${steps}: ${String(result.percent).padStart(3)}% ${result.stage.padEnd(10)} ${result.shotsDone}/${result.shotsTotal}`);
  if (result.error) { failure = result.error; break; }
  if (!result.more) break;
}

const { job } = await j(await fetch(`${BASE}/api/jobs/${id}`));
console.log(`render wall clock: ${((Date.now() - t0) / 1000).toFixed(1)}s across ${steps} step(s)`);
if (failure) { console.error('FAILED:', failure); process.exit(1); }

if (job.progress.stage === 'failed') {
  console.error('FAILED:', job.error);
  process.exit(1);
}

console.log('\nLOG:');
for (const l of job.logs.slice(-12)) console.log(`  [${l.level}] ${l.message}`);

// --- 4. verify -------------------------------------------------------------
const out = path.join(OUT_DIR, 'out.mp4');
const outUrl = job.output.url.startsWith('http') ? job.output.url : BASE + job.output.url;
const res = await fetch(outUrl);
fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));

const probe = (args) => execFileSync('ffprobe', args, { encoding: 'utf8' }).trim();
const videoDur = Number(probe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration,nb_frames', '-of', 'csv=p=0', out]).split(',')[0]);
const nbFrames = Number(probe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0', out]));
const audioDur = Number(probe(['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', out]));

console.log('\n=== VERIFICATION ===');
console.log(`voiceover source : 46.500s`);
console.log(`output video     : ${videoDur.toFixed(3)}s  (${nbFrames} frames @30fps = ${(nbFrames / 30).toFixed(3)}s)`);
console.log(`output audio     : ${audioDur.toFixed(3)}s`);
const driftMs = Math.abs(videoDur - audioDur) * 1000;
console.log(`video vs audio   : ${driftMs.toFixed(1)}ms  ${driftMs <= 1000 / 30 ? 'PASS (under one frame)' : 'FAIL'}`);

// --- 5. sample frames: is the right clip on screen at the right moment? ----
// Each source clip is a distinct solid colour, so the pixel at the centre of a
// frame identifies which clip is playing.
const COLOURS = {
  'drake_court_01.mp4': [0xe0, 0x20, 0x20],
  'drake_stage.mp4': [0xc0, 0x18, 0x18],
  'kendrik_superbowl.mp4': [0x20, 0xa0, 0x20],
  'umg_building.mp4': [0x20, 0x60, 0xe0],
  'faisal_desk.mp4': [0xe0, 0xc0, 0x20],
  'city_broll.mp4': [0x80, 0x80, 0x80],
};

const nearest = (rgb) => {
  let best = null, bestD = Infinity;
  for (const [name, c] of Object.entries(COLOURS)) {
    const d = Math.hypot(rgb[0] - c[0], rgb[1] - c[1], rgb[2] - c[2]);
    if (d < bestD) { bestD = d; best = name; }
  }
  return { name: best, distance: bestD };
};

console.log('');
console.log('=== FRAME CHECK (which clip is on screen) ===');
let pass = 0, fail = 0;
for (const shot of job.shots) {
  // Sample the middle of the shot, away from any cut.
  const atSec = (shot.startMs + shot.durationMs / 2) / 1000;
  const raw = execFileSync('ffmpeg', [
    '-v', 'error', '-ss', atSec.toFixed(3), '-i', out,
    '-frames:v', '1', '-vf', 'crop=2:2:iw/2:ih/2', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { maxBuffer: 1 << 20 });
  const got = nearest([raw[0], raw[1], raw[2]]);
  const ok = got.name === shot.clipFilename;
  if (ok) pass++; else fail++;
  console.log(
    `  t=${atSec.toFixed(2).padStart(6)}s  expected ${shot.clipFilename.padEnd(24)} got ${got.name.padEnd(24)} ${ok ? 'OK' : 'MISMATCH'}`,
  );
}
console.log('');
console.log(`${pass}/${pass + fail} shots show the correct clip.`);
process.exit(fail === 0 && driftMs <= 1000 / 30 ? 0 : 1);
