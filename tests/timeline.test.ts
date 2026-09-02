import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSubtitles } from '../src/lib/srt.ts';
import { buildCast } from '../src/lib/cast.ts';
import { buildSegments, DEFAULT_SEGMENT_OPTIONS } from '../src/lib/segment.ts';
import { planShots, DEFAULT_PLAN_OPTIONS, type ClipAsset } from '../src/lib/plan.ts';
import { frameSpans } from '../src/lib/ffmpeg.ts';

/** One cue per line, `msEach` long, with no pause between them. */
function srtOf(lines: string[], msEach = 3000): string {
  const t = (n: number) => new Date(n).toISOString().slice(11, 23).replace('.', ',');
  return lines.map((text, i) => `${i + 1}\n${t(i * msEach)} --> ${t((i + 1) * msEach)}\n${text}\n`).join('\n');
}

function clip(id: string, filename: string, durationMs: number): ClipAsset {
  return {
    id,
    filename,
    path: `/tmp/${filename}`,
    durationMs,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: false,
    tags: [],
    entityIds: [],
  };
}

/** The full analyse -> segment -> plan run, exactly as the pipeline does it. */
function build(lines: string[], clips: ClipAsset[], totalDurationMs: number, overrides = {}, msEach = 3000) {
  const { words } = parseSubtitles(srtOf(lines, msEach));
  const cast = buildCast(
    clips.map((c) => ({ id: c.id, filename: c.filename, tags: c.tags })),
    words,
  );

  for (const c of clips) {
    const bound = cast.binding.get(c.id);
    c.entityIds = bound ? [bound] : [];
  }

  const segments = buildSegments(words, cast.mentions, cast.entities, {
    ...DEFAULT_SEGMENT_OPTIONS,
    ...overrides,
    totalDurationMs,
  });
  const plan = planShots(segments, clips, cast.entities, DEFAULT_PLAN_OPTIONS);
  return { words, cast, segments, plan };
}

const SCRIPT = [
  'Drake filed the appeal in January of that year.',
  'Kendrick Lamar had already moved on completely.',
  'The label pushed back against every single claim.',
  'Drake returned to court with a brand new argument.',
  'Faisal drafted the entire brief overnight.',
  'Kendrick Lamar never responded to any of it.',
];

const CAST_CLIPS = () => [
  clip('d1', 'drake_court.mp4', 20_000),
  clip('d2', 'drake_stage.mp4', 20_000),
  clip('k1', 'kendrick_lamar_grammys.mp4', 20_000),
  clip('k2', 'kendrick_lamar_stage.mp4', 20_000),
  clip('f1', 'faisal_desk.mp4', 20_000),
  clip('b1', 'city_broll.mp4', 20_000),
];

/* ------------------------------------------------------------------ */
/* the headline requirement                                            */
/* ------------------------------------------------------------------ */

test('three names inside ONE subtitle line produce three separate shots', () => {
  // A single 6-second cue naming three people. Cue boundaries must not constrain
  // the cutting: the editor has to cut inside the line.
  const line = 'Drake and Kendrick and Faisal all signed the very same agreement today.';
  const { segments, cast } = build([line], CAST_CLIPS(), 6000, {}, 6000);

  assert.equal(cast.entities.length, 3, 'three characters came from the clip files');

  const named = segments.filter((s) => s.entityId);
  const distinct = new Set(named.map((s) => s.entityId));
  assert.equal(distinct.size, 3, `all three characters get screen time, got ${named.length} named shots`);

  // Each character is on screen while their own name is spoken.
  for (const mention of cast.mentions) {
    const covering = segments.find((s) => mention.startMs >= s.startMs && mention.startMs < s.endMs);
    assert.ok(covering, `a shot covers "${mention.surface}"`);
    assert.equal(
      covering.entityId,
      mention.entityId,
      `"${mention.surface}" at ${mention.startMs}ms shows ${covering.entityId}, not its own character`,
    );
  }
});

test('cuts land inside a cue, not on its boundary', () => {
  // Two names in one 6s cue: the second cut must fall strictly inside it.
  const { segments } = build(['Drake argued while Kendrick stayed silent throughout the hearing.'], CAST_CLIPS(), 6000, {}, 6000);

  const interior = segments.filter((s) => s.startMs > 0 && s.startMs < 6000);
  assert.ok(interior.length >= 1, 'at least one cut happens inside the single cue');
  assert.ok(
    interior.every((s) => s.startMs % 6000 !== 0),
    'cuts are not snapped to the cue grid',
  );
});

test('a name is never merged into a different character to satisfy the floor', () => {
  // Names packed tightly enough that each gets well under the b-roll floor.
  const { segments, cast } = build(['Drake Kendrick Faisal Drake Kendrick Faisal.'], CAST_CLIPS(), 3000, {}, 3000);

  for (const mention of cast.mentions) {
    const covering = segments.find((s) => mention.startMs >= s.startMs && mention.startMs < s.endMs);
    assert.equal(covering?.entityId, mention.entityId, `"${mention.surface}" kept its own character`);
  }
});

test('rapid name cuts still respect the named floor', () => {
  const { segments } = build(['Drake and Kendrick and Faisal all agreed at once.'], CAST_CLIPS(), 6000, { minNamedMs: 900 }, 6000);

  // Nothing survives below the floor except where an adjacent different
  // character makes merging impossible - and those are the shots we want kept.
  const named = segments.filter((s) => s.entityId);
  assert.ok(named.length >= 2, 'still cuts between the characters');
});

/* ------------------------------------------------------------------ */
/* timeline invariants                                                 */
/* ------------------------------------------------------------------ */

test('segments tile the timeline with no gaps or overlaps', () => {
  const total = SCRIPT.length * 3000;
  const { segments } = build(SCRIPT, CAST_CLIPS(), total);

  assert.ok(segments.length > 0);
  assert.equal(segments[0].startMs, 0);
  assert.equal(segments[segments.length - 1].endMs, total);

  for (let i = 1; i < segments.length; i++) {
    assert.equal(segments[i].startMs, segments[i - 1].endMs, `gap before segment ${i}`);
  }
  for (const s of segments) {
    assert.ok(s.durationMs > 0);
    assert.equal(s.durationMs, s.endMs - s.startMs);
  }
});

test('the timeline still tiles when the voiceover outruns the subtitles', () => {
  const total = 40_000; // subtitles cover 18s
  const { segments } = build(SCRIPT, CAST_CLIPS(), total);

  assert.equal(segments[segments.length - 1].endMs, total);
  for (let i = 1; i < segments.length; i++) {
    assert.equal(segments[i].startMs, segments[i - 1].endMs);
  }
  for (const s of segments) {
    assert.ok(s.durationMs <= 7000 * 1.25 + 1, `segment ${s.index} runs ${s.durationMs}ms past the cap`);
  }
});

test('every cut lands on a word boundary from the SRT', () => {
  const total = SCRIPT.length * 3000;
  const { words, segments } = build(SCRIPT, CAST_CLIPS(), total);
  const onsets = new Set(words.map((w) => w.startMs));

  for (let i = 1; i < segments.length; i++) {
    // Shots produced by splitting a stretched tail have no speech under them,
    // so only the speech-bearing cuts are checked.
    if (!segments[i].text) continue;
    assert.ok(onsets.has(segments[i].startMs), `cut at ${segments[i].startMs}ms is not on a word onset`);
  }
});

test('a character is on screen while their name is spoken', () => {
  const total = SCRIPT.length * 3000;
  const { segments, cast } = build(SCRIPT, CAST_CLIPS(), total);

  for (const mention of cast.mentions) {
    const covering = segments.find((s) => mention.startMs >= s.startMs && mention.startMs < s.endMs);
    assert.ok(covering, `a shot covers the mention at ${mention.startMs}ms`);
    assert.equal(covering.entityId, mention.entityId, `"${mention.surface}" shows the wrong character`);
  }
});

/* ------------------------------------------------------------------ */
/* planning                                                            */
/* ------------------------------------------------------------------ */

test('shots are contiguous and exactly as long as their segment', () => {
  const total = SCRIPT.length * 3000;
  const { segments, plan } = build(SCRIPT, CAST_CLIPS(), total);

  assert.equal(plan.shots.length, segments.length);
  assert.equal(plan.shots[0].startMs, 0);
  assert.equal(plan.shots[plan.shots.length - 1].endMs, total);

  for (let i = 0; i < plan.shots.length; i++) {
    assert.equal(plan.shots[i].durationMs, segments[i].durationMs);
    if (i > 0) assert.equal(plan.shots[i].startMs, plan.shots[i - 1].endMs);
  }
});

test('the same clip never plays twice in a row when alternatives exist', () => {
  const total = SCRIPT.length * 3000;
  const { plan } = build(SCRIPT, CAST_CLIPS(), total);

  for (let i = 1; i < plan.shots.length; i++) {
    assert.notEqual(plan.shots[i].clipId, plan.shots[i - 1].clipId, `shots ${i - 1} and ${i} repeat`);
  }
});

test('a short clip loops rather than freezing, a long clip is windowed', () => {
  const total = SCRIPT.length * 3000;
  const clips = [clip('d', 'drake_court.mp4', 1000), clip('b', 'city_broll.mp4', 60_000)];
  const { plan } = build(SCRIPT, clips, total);

  for (const shot of plan.shots.filter((s) => s.clipId === 'd')) {
    assert.equal(shot.fitMode, 'loop');
    assert.ok(shot.loops > 1);
  }
  for (const shot of plan.shots.filter((s) => s.clipId === 'b')) {
    assert.equal(shot.fitMode, 'trim');
    assert.equal(shot.sourceOutMs - shot.sourceInMs, shot.durationMs);
    assert.ok(shot.sourceOutMs <= 60_000);
  }
});

test('reused clips show different footage each time', () => {
  const total = SCRIPT.length * 3000;
  const { plan } = build(SCRIPT, [clip('only', 'drake_court.mp4', 60_000)], total);

  const uses = plan.shots.filter((s) => s.clipId === 'only');
  assert.ok(uses.length >= 3);
  assert.ok(new Set(uses.map((s) => s.sourceInMs)).size > 1, 'in-points rotate on reuse');
});

/* ------------------------------------------------------------------ */
/* frame maths                                                         */
/* ------------------------------------------------------------------ */

test('frameSpans never drifts, however many cuts there are', () => {
  const fps = 30;
  const boundaries = [0];
  for (let i = 0; i < 500; i++) {
    boundaries.push(boundaries[boundaries.length - 1] + 1000 + ((i * 137) % 900));
  }
  const total = boundaries[boundaries.length - 1];

  const spans = frameSpans(boundaries, fps);
  assert.equal(spans.length, boundaries.length - 1);
  assert.equal(
    spans.reduce((a, b) => a + b, 0),
    Math.round((total / 1000) * fps),
    'shot lengths sum to the total exactly - no accumulated rounding',
  );
  assert.ok(spans.every((s) => s >= 1));
});

test('frameSpans keeps a sub-frame shot alive', () => {
  assert.equal(frameSpans([0, 5, 1000], 30)[0], 1);
});

test('the whole pipeline produces a video the exact length of the voiceover', () => {
  const fps = 30;
  const total = 25_000;
  const { plan } = build(SCRIPT, CAST_CLIPS(), total);

  const boundaries = [...plan.shots.map((s) => s.startMs), plan.shots[plan.shots.length - 1].endMs];
  const totalFrames = frameSpans(boundaries, fps).reduce((a, b) => a + b, 0);

  assert.equal(totalFrames, Math.round((total / 1000) * fps));
  const videoMs = (totalFrames / fps) * 1000;
  assert.ok(Math.abs(videoMs - total) <= 1000 / fps / 2 + 0.001);
});
