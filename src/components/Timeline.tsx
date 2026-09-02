'use client';

import { useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { Job } from '@/lib/jobs';
import { formatClock } from '@/lib/time';

interface Props {
  job: Job;
  selected: number | null;
  onSelect: (index: number | null) => void;
}

/**
 * Character colours.
 *
 * Re-picked for a white ground rather than inverted from the dark set: the
 * pastels that read well on near-black (#5b8cff, #37d399) wash out completely
 * on white. These are mid-tone and saturated so a half-second shot two pixels
 * wide is still identifiable, which is exactly where a rapid-fire run of name
 * cuts has to stay readable.
 */
export const LANE_COLOURS = [
  '#2f5fe0',
  '#0e9b62',
  '#c8790a',
  '#d5303c',
  '#7048d8',
  '#0e8ba8',
  '#d1571f',
  '#c02f86',
];

/** Light enough to recede behind the named lanes, dark enough to stay visible. */
export const BROLL_COLOUR = '#aeb7c6';

/** Bucket key for shots with no character, kept distinct from any entity id. */
const BROLL_LANE = '__broll';

export function useLaneColours(job: Job) {
  return useMemo(() => {
    const map = new Map<string, string>();
    job.entities.forEach((e, i) => map.set(e.id, LANE_COLOURS[i % LANE_COLOURS.length]));
    return map;
  }, [job.entities]);
}

/**
 * The edit, drawn as a ruler plus one lane per character.
 *
 * A single stacked strip tells you the order of shots but not whose video it
 * is; separate lanes make the *rhythm* of the edit legible at a glance - who
 * carries which stretch, where a character disappears for two minutes, where
 * the cutting goes rapid-fire because three names land in one line. That
 * reading is the thing you actually need before committing to a render, and it
 * is not something a flat list of shots can give you.
 */
export function Timeline({ job, selected, onSelect }: Props) {
  const [hoverMs, setHoverMs] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const colours = useLaneColours(job);

  const totalMs = job.shots.length ? job.shots[job.shots.length - 1].endMs : 0;

  // One pass over the shots, bucketed by character. The obvious version -
  // filtering the whole shot list once per lane - is O(lanes x shots) and
  // allocates a fresh copy of every shot for each lane it does not belong to.
  // With 270 shots and six characters that is ~1900 throwaway objects rebuilt
  // on every render, including every progress tick during a render.
  const lanes = useMemo(() => {
    const buckets = new Map<string, { index: number; shot: (typeof job.shots)[number] }[]>();

    for (let i = 0; i < job.shots.length; i++) {
      const key = job.shots[i].entityId ?? BROLL_LANE;
      const bucket = buckets.get(key);
      if (bucket) bucket.push({ index: i, shot: job.shots[i] });
      else buckets.set(key, [{ index: i, shot: job.shots[i] }]);
    }

    const rows = job.entities
      .filter((e) => buckets.has(e.id))
      .map((e) => ({
        id: e.id,
        label: e.canonical,
        colour: colours.get(e.id) ?? LANE_COLOURS[0],
        shots: buckets.get(e.id)!,
      }));

    const broll = buckets.get(BROLL_LANE);
    if (broll) rows.push({ id: BROLL_LANE, label: 'B-roll', colour: BROLL_COLOUR, shots: broll });

    return rows;
  }, [job.entities, job.shots, colours]);

  if (!job.shots.length) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-4 py-14 text-center">
        <p className="text-sm text-ink-dim">No edit yet</p>
        <p className="max-w-xs text-xs text-ink-faint">
          Add subtitles and clips, then analyse. The cast comes from your clip filenames.
        </p>
      </div>
    );
  }

  const ticks = buildTicks(totalMs);

  const onMove = (e: React.MouseEvent) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHoverMs(Math.max(0, Math.min(totalMs, ((e.clientX - rect.left) / rect.width) * totalMs)));
  };

  return (
    <div className="select-none px-4 pb-4 pt-3">
      {/* ---- ruler ---- */}
      <div className="relative mb-1.5 h-4" style={{ marginLeft: LANE_LABEL_WIDTH }}>
        {ticks.map((ms) => (
          <span
            key={ms}
            className="mono absolute top-0 -translate-x-1/2 text-[10px] text-ink-faint"
            style={{ left: `${(ms / totalMs) * 100}%` }}
          >
            {formatClock(ms)}
          </span>
        ))}
      </div>

      {/* ---- lanes ---- */}
      <div
        ref={trackRef}
        className="relative"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverMs(null)}
      >
        {/* gridlines behind everything */}
        <div className="pointer-events-none absolute inset-0" style={{ marginLeft: LANE_LABEL_WIDTH }}>
          {ticks.map((ms) => (
            <span
              key={ms}
              className="absolute top-0 h-full w-px bg-line-soft"
              style={{ left: `${(ms / totalMs) * 100}%` }}
            />
          ))}
        </div>

        <div className="space-y-1">
          {lanes.map((lane) => (
            <div key={lane.id} className="flex items-center gap-2">
              <div
                className="flex shrink-0 items-center gap-1.5 overflow-hidden"
                style={{ width: LANE_LABEL_WIDTH }}
              >
                <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: lane.colour }} />
                <span className="truncate text-[11px] text-ink-dim" title={lane.label}>
                  {lane.label}
                </span>
              </div>

              <div className="lane-track relative h-7 flex-1">
                {lane.shots.map(({ index, shot }) => {
                  const isSelected = selected === index;
                  return (
                    <button
                      key={index}
                      onClick={() => onSelect(isSelected ? null : index)}
                      title={`${formatClock(shot.startMs)} – ${formatClock(shot.endMs)}\n${shot.clipFilename}`}
                      className={clsx(
                        'lane-block absolute top-0 h-full rounded-[3px] transition-[opacity,transform] duration-100',
                        isSelected
                          ? 'z-10 scale-y-110 opacity-100 ring-2 ring-[color:var(--text)] ring-offset-1'
                          : 'opacity-90 hover:opacity-100',
                        selected !== null && !isSelected && 'opacity-30',
                      )}
                      style={{
                        left: `${(shot.startMs / totalMs) * 100}%`,
                        // A hairline minimum so a 300ms shot is still clickable.
                        width: `max(2px, ${(shot.durationMs / totalMs) * 100}%)`,
                        background: lane.colour,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* ---- hover playhead ---- */}
        {hoverMs !== null && (
          <div
            className="pointer-events-none absolute top-0 h-full"
            style={{
              left: `calc(${LANE_LABEL_WIDTH}px + (100% - ${LANE_LABEL_WIDTH}px) * ${hoverMs / totalMs})`,
            }}
          >
            <div className="h-full w-px bg-[color:var(--text)] opacity-40" />
            <span className="mono absolute -top-5 -translate-x-1/2 rounded border border-line bg-surface-1 px-1.5 py-0.5 text-[10px] text-ink shadow-sm">
              {formatClock(hoverMs)}
            </span>
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-faint">
        <span>
          <span className="mono text-ink-dim">{job.shots.length}</span> shots
        </span>
        <span>
          <span className="mono text-ink-dim">{formatClock(totalMs)}</span> runtime
        </span>
        <span>
          median{' '}
          <span className="mono text-ink-dim">{(medianDuration(job) / 1000).toFixed(1)}s</span> per shot
        </span>
        <span>
          <span className="mono text-ink-dim">{job.shots.filter((s) => s.entityId).length}</span> on a
          named character
        </span>
      </div>
    </div>
  );
}

const LANE_LABEL_WIDTH = 104;

/** Round tick marks at a sensible interval for the runtime. */
function buildTicks(totalMs: number): number[] {
  if (totalMs <= 0) return [];
  const targets = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
  const step = (targets.find((s) => totalMs / (s * 1000) <= 12) ?? 3600) * 1000;

  const ticks: number[] = [];
  // Skip the final tick if it would collide with the right edge.
  for (let ms = 0; ms <= totalMs - step * 0.4; ms += step) ticks.push(ms);
  return ticks;
}

function medianDuration(job: Job): number {
  if (!job.shots.length) return 0;
  const sorted = job.shots.map((s) => s.durationMs).sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}
