import type { Segment } from './segment.ts';
import type { Entity } from './entities.ts';
import type { Ms } from './time.ts';

export interface ClipAsset {
  id: string;
  filename: string;
  /** Absolute path on disk. */
  path: string;
  durationMs: Ms;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  tags: string[];
  /** Entities this clip is bound to. Empty means it is general b-roll. */
  entityIds: string[];
}

export type FitMode = 'trim' | 'loop' | 'stretch';

export interface Shot {
  segmentIndex: number;
  /** Where this shot sits in the finished video. */
  startMs: Ms;
  endMs: Ms;
  durationMs: Ms;
  clipId: string;
  clipFilename: string;
  /** In/out points inside the source clip. */
  sourceInMs: Ms;
  sourceOutMs: Ms;
  fitMode: FitMode;
  /** How many times the source is repeated when fitMode is 'loop'. */
  loops: number;
  entityId: string | null;
  entityName: string | null;
  reason: string;
  text: string;
}

export interface PlanResult {
  shots: Shot[];
  warnings: string[];
  stats: {
    totalDurationMs: Ms;
    shotCount: number;
    namedShots: number;
    brollShots: number;
    /** Segments whose character had no clip available. */
    unmatchedShots: number;
    clipsUsed: number;
    clipReuse: Record<string, number>;
  };
}

export interface PlanOptions {
  /** Never play the same clip twice in a row. */
  avoidImmediateRepeat: boolean;
  /**
   * Rotate the in-point when a clip is reused, so a second appearance shows
   * different footage rather than replaying the same seconds.
   */
  rotateReusedFootage: boolean;
  /** Longest a clip may be looped to fill a segment before we stop repeating. */
  maxLoops: number;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  avoidImmediateRepeat: true,
  rotateReusedFootage: true,
  maxLoops: 6,
};

/**
 * Decide which clip fills each segment, and exactly which seconds of it.
 *
 * The output is a complete edit decision list: every shot carries its position
 * in the finished video and its in/out points in the source. Two properties
 * make the render deterministic and gap-free:
 *
 *   - `shot.durationMs` always equals `segment.durationMs`. The renderer
 *     trims, loops or stretches the source to hit it exactly, so no clip's own
 *     length can push the timeline out of sync with the voiceover.
 *   - Shots are contiguous: `shots[n].endMs === shots[n+1].startMs`, inherited
 *     from the segment tiling.
 *
 * Selection is least-recently-used within a character's pool, which spreads
 * footage evenly instead of hammering the first file alphabetically.
 */
export function planShots(
  segments: Segment[],
  clips: ClipAsset[],
  entities: Entity[],
  options: PlanOptions = DEFAULT_PLAN_OPTIONS,
): PlanResult {
  const warnings: string[] = [];
  const shots: Shot[] = [];

  if (!clips.length) {
    return {
      shots: [],
      warnings: ['No clips were provided, so there is nothing to build a video from.'],
      stats: emptyStats(),
    };
  }

  const entityById = new Map(entities.map((e) => [e.id, e]));
  const byEntity = new Map<string, ClipAsset[]>();
  for (const clip of clips) {
    for (const id of clip.entityIds) {
      const list = byEntity.get(id);
      if (list) list.push(clip);
      else byEntity.set(id, [clip]);
    }
  }

  // B-roll pool: clips bound to nobody. If every clip is bound to someone, the
  // whole library doubles as the b-roll pool rather than leaving gaps.
  const unbound = clips.filter((c) => c.entityIds.length === 0);
  const brollPool = unbound.length ? unbound : clips;

  /** Round-robin cursor and last-used ordinal per pool. */
  const cursor = new Map<string, number>();
  const lastUsedAt = new Map<string, number>();
  const useCount = new Map<string, number>();

  let unmatched = 0;
  let named = 0;
  let broll = 0;
  const missingWarned = new Set<string>();

  for (const segment of segments) {
    const entity = segment.entityId ? entityById.get(segment.entityId) ?? null : null;
    let pool = segment.entityId ? byEntity.get(segment.entityId) ?? [] : [];
    let reason: string;

    if (pool.length) {
      reason = segment.source === 'named' ? `named: ${entity?.canonical ?? segment.entityId}` : `carried from previous mention`;
      if (segment.source === 'named') named++;
      else broll++;
    } else {
      if (segment.entityId && !missingWarned.has(segment.entityId)) {
        missingWarned.add(segment.entityId);
        warnings.push(
          `No clip is tagged for "${entity?.canonical ?? segment.entityId}" - those moments fall back to b-roll.`,
        );
      }
      pool = brollPool;
      reason = segment.entityId ? 'no clip for this character - b-roll' : 'no character named - b-roll';
      if (segment.entityId) unmatched++;
      else broll++;
    }

    const previous = shots[shots.length - 1]?.clipId ?? null;
    const clip = pickClip(pool, previous, lastUsedAt, cursor, options, shots.length);

    const uses = useCount.get(clip.id) ?? 0;
    useCount.set(clip.id, uses + 1);
    lastUsedAt.set(clip.id, shots.length);

    const fit = fitSource(clip, segment.durationMs, uses, options);

    shots.push({
      segmentIndex: segment.index,
      startMs: segment.startMs,
      endMs: segment.endMs,
      durationMs: segment.durationMs,
      clipId: clip.id,
      clipFilename: clip.filename,
      sourceInMs: fit.inMs,
      sourceOutMs: fit.outMs,
      fitMode: fit.mode,
      loops: fit.loops,
      entityId: segment.entityId,
      entityName: entity?.canonical ?? null,
      reason,
      text: segment.text,
    });
  }

  const clipReuse: Record<string, number> = {};
  for (const [id, n] of useCount) {
    clipReuse[clips.find((c) => c.id === id)?.filename ?? id] = n;
  }

  const total = shots.length ? shots[shots.length - 1].endMs : 0;
  const overused = Object.entries(clipReuse).filter(([, n]) => n > Math.max(6, shots.length / 3));
  for (const [name, n] of overused) {
    warnings.push(`"${name}" is used ${n} times. Add more clips for that character to reduce repetition.`);
  }

  return {
    shots,
    warnings,
    stats: {
      totalDurationMs: total,
      shotCount: shots.length,
      namedShots: named,
      brollShots: broll,
      unmatchedShots: unmatched,
      clipsUsed: useCount.size,
      clipReuse,
    },
  };
}

/**
 * Least-recently-used pick, skipping the clip that just played.
 *
 * Round-robin alone repeats visibly when a pool has two clips and the script
 * alternates characters; LRU with an explicit "not the previous one" guard
 * keeps consecutive shots distinct whenever the pool makes it possible.
 */
function pickClip(
  pool: ClipAsset[],
  previousClipId: string | null,
  lastUsedAt: Map<string, number>,
  cursor: Map<string, number>,
  options: PlanOptions,
  position: number,
): ClipAsset {
  if (pool.length === 1) return pool[0];

  const eligible =
    options.avoidImmediateRepeat && previousClipId
      ? pool.filter((c) => c.id !== previousClipId)
      : pool;
  const candidates = eligible.length ? eligible : pool;

  let best = candidates[0];
  let bestSeen = lastUsedAt.get(best.id) ?? -1;
  for (const clip of candidates) {
    const seen = lastUsedAt.get(clip.id) ?? -1;
    if (seen < bestSeen) {
      best = clip;
      bestSeen = seen;
    }
  }
  return best;
}

/**
 * Choose the in/out points inside a source clip for a segment of exactly
 * `needMs`.
 *
 * Longer than needed -> take a window. The window start rotates with each
 * reuse so the third Drake shot is not the same three seconds as the first.
 * Shorter than needed -> loop the clip. Looping preserves motion and pacing;
 * freezing on the last frame or stretching to 4x looks broken. Only when a
 * clip is so short that looping would strobe (under 400ms) does it stretch.
 */
function fitSource(
  clip: ClipAsset,
  needMs: Ms,
  previousUses: number,
  options: PlanOptions,
): { inMs: Ms; outMs: Ms; mode: FitMode; loops: number } {
  const available = clip.durationMs;

  if (available <= 0) {
    return { inMs: 0, outMs: needMs, mode: 'stretch', loops: 1 };
  }

  if (available >= needMs) {
    const slack = available - needMs;
    let inMs = 0;

    if (options.rotateReusedFootage && slack > 250) {
      // Walk through the clip on each reuse, wrapping around the slack. The
      // first use starts at 0 so the most recognisable opening frame leads.
      const step = Math.max(500, Math.floor(slack / 4));
      inMs = (previousUses * step) % (slack + 1);
    }

    return { inMs, outMs: inMs + needMs, mode: 'trim', loops: 1 };
  }

  if (available < 400) {
    return { inMs: 0, outMs: available, mode: 'stretch', loops: 1 };
  }

  const loops = Math.min(options.maxLoops, Math.ceil(needMs / available));
  return { inMs: 0, outMs: available, mode: 'loop', loops };
}

function emptyStats(): PlanResult['stats'] {
  return {
    totalDurationMs: 0,
    shotCount: 0,
    namedShots: 0,
    brollShots: 0,
    unmatchedShots: 0,
    clipsUsed: 0,
    clipReuse: {},
  };
}
