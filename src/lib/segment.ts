import { sentenceRanges, type Word } from './srt.ts';
import { CARRY_FORWARD } from './stopwords.ts';
import type { Entity, Mention } from './entities.ts';
import type { Ms } from './time.ts';

export interface SegmentOptions {
  /**
   * Floor for a shot that exists because a character was named.
   *
   * Kept far below the b-roll floor on purpose: when one subtitle line says
   * "Drake, Kendrick and Faisal all agreed", each name may only get 600ms of
   * speech, and merging those away would show one face while three are being
   * named. Rapid cuts are the correct output there.
   */
  minNamedMs: Ms;
  /** Floor for a shot with no character attached. */
  minBrollMs: Ms;
  /** A shot longer than this is split so the visual keeps moving. */
  maxDurationMs: Ms;
  /** Hold the last-named character through follow-up sentences. */
  carryForward: boolean;
  /** How long a carried subject survives with no new mention. */
  carryForwardMs: Ms;
  /** Total timeline length - the voiceover duration. */
  totalDurationMs: Ms;
}

export const DEFAULT_SEGMENT_OPTIONS: Omit<SegmentOptions, 'totalDurationMs'> = {
  minNamedMs: 600,
  minBrollMs: 2000,
  maxDurationMs: 7000,
  carryForward: true,
  carryForwardMs: 9000,
};

export interface Segment {
  index: number;
  startMs: Ms;
  endMs: Ms;
  durationMs: Ms;
  /** null means no character was named here - this slot takes b-roll. */
  entityId: string | null;
  source: 'named' | 'carried' | 'broll';
  confidence: number;
  /** The words spoken over this segment. */
  text: string;
  fromWord: number;
  toWord: number;
  /** The mention that caused this cut, for the UI to explain itself. */
  triggerSurface: string | null;
}

/**
 * Turn name mentions into cut points.
 *
 * The rule is simply: **the person being named is the person on screen.** A cut
 * is placed wherever the subject changes, at the millisecond the new name is
 * spoken - not at the start of the subtitle line that happens to contain it.
 *
 * That distinction is the whole point. Subtitle line breaks are an artefact of
 * how the captions were formatted; they have nothing to do with who is being
 * talked about. A single line reading "Drake, Kendrick and Faisal all agreed"
 * must produce three shots, and a name landing two-thirds of the way through a
 * line must cut two-thirds of the way through it. Cue boundaries are never
 * consulted here - only the word-level timings the cues imply.
 *
 * Two invariants hold on the way out:
 *
 *   1. Segments tile `[0, totalDurationMs]` exactly - no gaps, no overlaps.
 *   2. Every boundary sits on a word onset taken from the SRT, so a cut never
 *      lands halfway through a spoken word.
 */
export function buildSegments(
  words: Word[],
  mentions: Mention[],
  entities: Entity[],
  options: SegmentOptions,
): Segment[] {
  if (!words.length) {
    return options.totalDurationMs > 0 ? [wholeTimeline(options.totalDurationMs)] : [];
  }

  const known = new Set(entities.map((e) => e.id));
  const ordered = mentions
    .filter((m) => known.has(m.entityId))
    .slice()
    .sort((a, b) => a.wordIndex - b.wordIndex);

  if (!ordered.length) {
    return normalise(words, [makeSegment(words, 0, words.length, null, 'broll', 0, null)], options);
  }

  // --- 1. collapse repeats -------------------------------------------------
  // Consecutive mentions of the same person are one continuous shot; saying
  // "Drake" three times in a row is not three cuts.
  const changes: Mention[] = [];
  for (const mention of ordered) {
    const previous = changes[changes.length - 1];
    if (previous && previous.entityId === mention.entityId) continue;
    changes.push(mention);
  }

  // --- 2. one cut per subject change ---------------------------------------
  const cuts: { atWord: number; mention: Mention }[] = [];
  let floor = 0;
  for (const mention of changes) {
    const atWord = Math.max(floor, clauseStart(words, mention.wordIndex, floor));
    // Two names close enough to share a cut point: keep the later one, since
    // it is the subject for the words that follow.
    if (cuts.length && atWord <= cuts[cuts.length - 1].atWord) {
      cuts[cuts.length - 1] = { atWord: cuts[cuts.length - 1].atWord, mention };
      continue;
    }
    cuts.push({ atWord, mention });
    floor = atWord + 1;
  }

  // --- 3. spans between cuts ------------------------------------------------
  const raw: Segment[] = [];

  if (cuts[0].atWord > 0) {
    // Everything before the first name is b-roll.
    raw.push(makeSegment(words, 0, cuts[0].atWord, null, 'broll', 0, null));
  }

  for (let i = 0; i < cuts.length; i++) {
    const from = cuts[i].atWord;
    const to = i + 1 < cuts.length ? cuts[i + 1].atWord : words.length;
    if (to <= from) continue;

    const mention = cuts[i].mention;
    const segment = makeSegment(words, from, to, mention.entityId, 'named', mention.confidence, mention.surface);

    // A character holds the screen only while the narration is still about
    // them. Once it stops referring back, the tail becomes b-roll rather than
    // leaving one face up through an unrelated paragraph.
    const split = options.carryForward
      ? carryForwardCutoff(words, from, to, mention.endMs, options.carryForwardMs)
      : from + 1;

    if (split > from && split < to) {
      raw.push(makeSegment(words, from, split, mention.entityId, 'named', mention.confidence, mention.surface));
      raw.push(makeSegment(words, split, to, null, 'broll', 0, null));
    } else {
      raw.push(segment);
    }
  }

  return normalise(words, mergeAdjacent(raw), options);
}

/* ------------------------------------------------------------------ */

/**
 * Where does the narration stop being about the character just named?
 *
 * Walks forward sentence by sentence. A sentence that refers back with a
 * pronoun or a role phrase ("he", "his lawyers", "the label") keeps them on
 * screen; the first sentence that does neither, past the time budget, ends the
 * hold. Returns an index inside `(from, to)`, or `to` to hold throughout.
 */
function carryForwardCutoff(words: Word[], from: number, to: number, mentionEndMs: Ms, budgetMs: Ms): number {
  const sentences = sentenceRanges(words.slice(from, to));
  if (sentences.length <= 1) return to;

  for (const sentence of sentences) {
    const startsAt = from + sentence.from;
    if (startsAt <= from) continue; // the sentence containing the name itself
    if (words[startsAt].startMs - mentionEndMs <= budgetMs && refersBack(sentence.text)) continue;
    return startsAt;
  }

  return to;
}

function refersBack(text: string): boolean {
  return (
    CARRY_FORWARD.thirdPersonSingular.test(text) ||
    CARRY_FORWARD.roleReference.test(text) ||
    CARRY_FORWARD.thirdPersonPlural.test(text)
  );
}

/**
 * Walk back from a name to the start of its clause.
 *
 * A cut placed exactly on the name arrives after the viewer has already heard
 * the subject change. Backing up to the last comma, conjunction or dash - but
 * no more than a few words - puts the cut on the natural beat instead.
 */
function clauseStart(words: Word[], mentionIndex: number, floor: number): number {
  const LOOKBACK = 5;
  const CONNECTORS = new Set(['and', 'but', 'while', 'whereas', 'meanwhile', 'then', 'so', 'because', 'when', 'as', 'yet', 'plus', 'versus', 'vs']);

  for (let i = mentionIndex - 1; i >= Math.max(floor, mentionIndex - LOOKBACK); i--) {
    if (/[,;:—–-]$/.test(words[i].raw)) return i + 1;
    if (CONNECTORS.has(words[i].norm)) return i;
  }
  return mentionIndex;
}

function makeSegment(
  words: Word[],
  from: number,
  to: number,
  entityId: string | null,
  source: Segment['source'],
  confidence: number,
  triggerSurface: string | null,
): Segment {
  const startMs = words[from].startMs;
  const endMs = words[to - 1].endMs;
  return {
    index: 0,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    entityId,
    source,
    confidence,
    text: words.slice(from, to).map((w) => w.raw).join(' '),
    fromWord: from,
    toWord: to,
    triggerSurface,
  };
}

function wholeTimeline(totalDurationMs: Ms): Segment {
  return {
    index: 0,
    startMs: 0,
    endMs: totalDurationMs,
    durationMs: totalDurationMs,
    entityId: null,
    source: 'broll',
    confidence: 0,
    text: '',
    fromWord: 0,
    toWord: 0,
    triggerSurface: null,
  };
}

function mergeAdjacent(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (prev && prev.entityId === seg.entityId && prev.toWord === seg.fromWord) {
      prev.endMs = seg.endMs;
      prev.durationMs = prev.endMs - prev.startMs;
      prev.toWord = seg.toWord;
      prev.text = `${prev.text} ${seg.text}`.trim();
      continue;
    }
    out.push({ ...seg });
  }
  return out;
}

/* ------------------------------------------------------------------ */

function normalise(words: Word[], segments: Segment[], options: SegmentOptions): Segment[] {
  let out = enforceFloors(segments, options);
  out = enforceCeiling(words, out, options.maxDurationMs);
  return closeGaps(out, options.totalDurationMs, options.maxDurationMs);
}

/**
 * Absorb shots too short to read as a deliberate cut.
 *
 * Named shots get a much lower floor than b-roll, and a named shot is never
 * merged into a *different* character - that would put the wrong face on the
 * screen, which is worse than a fast cut. Only same-character or b-roll
 * neighbours can absorb one.
 */
function enforceFloors(segments: Segment[], options: SegmentOptions): Segment[] {
  if (segments.length <= 1) return segments.map((s) => ({ ...s }));

  const out = segments.map((s) => ({ ...s }));
  let changed = true;

  while (changed && out.length > 1) {
    changed = false;

    for (let i = 0; i < out.length; i++) {
      const seg = out[i];
      const floor = seg.entityId ? options.minNamedMs : options.minBrollMs;
      if (seg.durationMs >= floor) continue;

      const prev = out[i - 1];
      const next = out[i + 1];

      // Prefer a neighbour showing the same character - merging there changes
      // nothing on screen. Otherwise a named sliver may only be absorbed by
      // b-roll, never by a different character.
      const sameCharacter =
        prev?.entityId === seg.entityId ? prev : next?.entityId === seg.entityId ? next : null;

      let target = sameCharacter;
      if (!target) {
        const candidates = [prev, next].filter(
          (n): n is Segment => Boolean(n) && (!seg.entityId || !n!.entityId),
        );
        target = candidates.sort((a, b) => a.durationMs - b.durationMs)[0] ?? null;
      }

      if (!target) continue; // a named sliver between two other characters stays

      absorb(target, seg);
      out.splice(i, 1);
      changed = true;
      break;
    }
  }

  return out;
}

function absorb(target: Segment, victim: Segment): void {
  const victimFirst = victim.fromWord < target.fromWord;
  target.startMs = Math.min(target.startMs, victim.startMs);
  target.endMs = Math.max(target.endMs, victim.endMs);
  target.durationMs = target.endMs - target.startMs;
  target.fromWord = Math.min(target.fromWord, victim.fromWord);
  target.toWord = Math.max(target.toWord, victim.toWord);
  target.text = victimFirst ? `${victim.text} ${target.text}`.trim() : `${target.text} ${victim.text}`.trim();
}

/**
 * Split shots that run too long.
 *
 * Holding one frame for thirty seconds is what makes an automated edit look
 * automated. Long stretches are divided on word boundaries; each part keeps the
 * same character, and the planner hands each a different clip, so the subject
 * stays put while the footage keeps moving.
 */
function enforceCeiling(words: Word[], segments: Segment[], maxMs: Ms): Segment[] {
  const out: Segment[] = [];

  for (const seg of segments) {
    // A segment needs at least a word per part to be divisible on word onsets.
    if (seg.durationMs <= maxMs || seg.toWord - seg.fromWord < 4) {
      out.push({ ...seg });
      continue;
    }

    const parts = Math.ceil(seg.durationMs / maxMs);
    const target = seg.durationMs / parts;

    let from = seg.fromWord;
    for (let p = 0; p < parts && from < seg.toWord; p++) {
      // Every part except the last ends at the word onset nearest its share of
      // the span. Rebuilding each part with makeSegment is what keeps the cut
      // on a real word boundary - deriving times from word positions instead
      // produced wildly uneven splits.
      const to =
        p === parts - 1
          ? seg.toWord
          : nearestWordOnset(words, from + 1, seg.toWord, seg.startMs + target * (p + 1));

      const bounded = Math.max(from + 1, Math.min(to, seg.toWord));
      out.push(makeSegment(words, from, bounded, seg.entityId, seg.source, seg.confidence, p === 0 ? seg.triggerSurface : null));
      from = bounded;
    }
  }

  return out;
}

/** Word index in `[lo, hi)` whose onset is closest to `targetMs`. */
function nearestWordOnset(words: Word[], lo: number, hi: number, targetMs: Ms): number {
  let best = lo;
  let bestDelta = Infinity;

  for (let i = lo; i < hi; i++) {
    const delta = Math.abs(words[i].startMs - targetMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    } else if (words[i].startMs > targetMs) {
      break; // onsets are monotonic, so it only gets worse from here
    }
  }

  return best;
}

/**
 * Close every gap so the shots tile the timeline exactly.
 *
 * SRT cues have silence between them - pauses, breaths, music beds. That
 * silence belongs to whichever shot is already on screen; leaving it
 * unassigned is what produces black frames and lets the video drift shorter
 * than the audio. The first shot is stretched back to 0 and the last forward to
 * the true voiceover duration, which is what makes the finished video exactly
 * as long as the narration.
 */
function closeGaps(segments: Segment[], totalDurationMs: Ms, maxDurationMs: Ms): Segment[] {
  if (!segments.length) {
    return totalDurationMs > 0 ? [wholeTimeline(totalDurationMs)] : [];
  }

  const out = segments.map((s) => ({ ...s })).sort((a, b) => a.startMs - b.startMs);

  out[0].startMs = 0;
  for (let i = 0; i < out.length - 1; i++) {
    // Hand the pause to the outgoing shot: a cut on the next word's onset reads
    // as intentional, a cut mid-pause reads as a glitch.
    out[i].endMs = out[i + 1].startMs;
  }

  const end = totalDurationMs > 0 ? totalDurationMs : out[out.length - 1].endMs;
  out[out.length - 1].endMs = Math.max(end, out[out.length - 1].startMs + 1);

  // Stretching the first and last shots to cover the whole voiceover can leave
  // them far past the cap - a script whose subtitles stop ten seconds before
  // the audio would end on a single frozen frame. Split those again. There is
  // no speech in the stretched region, so these cuts are made on time.
  const capped: Segment[] = [];
  for (const seg of out) {
    const duration = seg.endMs - seg.startMs;
    // The tolerance stops a shot that merely absorbed a pause from being
    // chopped in half over a few hundred milliseconds.
    if (duration <= maxDurationMs * 1.25) {
      capped.push(seg);
      continue;
    }

    const parts = Math.ceil(duration / maxDurationMs);
    for (let p = 0; p < parts; p++) {
      capped.push({
        ...seg,
        startMs: seg.startMs + Math.round((duration * p) / parts),
        endMs: p === parts - 1 ? seg.endMs : seg.startMs + Math.round((duration * (p + 1)) / parts),
        text: p === 0 ? seg.text : '',
        triggerSurface: p === 0 ? seg.triggerSurface : null,
      });
    }
  }

  return capped
    .map((s, i) => ({ ...s, index: i, durationMs: s.endMs - s.startMs }))
    .filter((s) => s.durationMs > 0);
}
