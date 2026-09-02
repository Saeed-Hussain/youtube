'use client';

import clsx from 'clsx';
import type { Job } from '@/lib/jobs';
import { formatClock } from '@/lib/time';
import { useLaneColours, BROLL_COLOUR } from './Timeline';

interface Props {
  job: Job;
  index: number;
  onSwapClip: (shotIndex: number, clipId: string) => void;
  onStep: (delta: number) => void;
  onClose: () => void;
}

/**
 * Everything about one shot, and the one control that can change it.
 *
 * Only the source clip is editable. Timing is derived from where the name is
 * spoken, so exposing it as an editable field would invite the user to break
 * the sync the whole system exists to guarantee - and a swap can therefore
 * never require re-analysis.
 */
export function ShotInspector({ job, index, onSwapClip, onStep, onClose }: Props) {
  const shot = job.shots[index];
  const colours = useLaneColours(job);
  if (!shot) return null;

  const colour = shot.entityId ? colours.get(shot.entityId) ?? BROLL_COLOUR : BROLL_COLOUR;
  const clip = job.clips.find((c) => c.id === shot.clipId);

  // Clips of this character first, then everything else - the useful swap is
  // almost always another angle of the same person.
  const sameCharacter = job.clips.filter((c) => shot.entityId && c.entityIds.includes(shot.entityId));
  const others = job.clips.filter((c) => !sameCharacter.includes(c));

  return (
    <div className="border-t border-line bg-surface-2 shadow-[inset_0_6px_10px_-8px_rgba(20,23,30,0.22)]">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: colour }} />
          <span className="text-sm font-medium text-ink">{shot.entityName ?? 'B-roll'}</span>
          <span className="mono text-xs text-ink-faint">
            shot {index + 1} of {job.shots.length}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button className="btn btn-ghost px-2 py-1" onClick={() => onStep(-1)} disabled={index === 0} title="Previous shot">
            ←
          </button>
          <button
            className="btn btn-ghost px-2 py-1"
            onClick={() => onStep(1)}
            disabled={index === job.shots.length - 1}
            title="Next shot"
          >
            →
          </button>
          <button className="btn btn-ghost px-2 py-1" onClick={onClose} title="Close">
            ✕
          </button>
        </div>
      </div>

      <div className="grid gap-4 px-4 pb-4 md:grid-cols-[1fr_260px]">
        <div className="min-w-0">
          <div className="mono flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-dim">
            <span className="text-accent">
              {formatClock(shot.startMs)} → {formatClock(shot.endMs)}
            </span>
            <span>{(shot.durationMs / 1000).toFixed(2)}s</span>
            {shot.fitMode !== 'trim' && (
              <span className={clsx(shot.fitMode === 'loop' ? 'text-warn' : 'text-bad')}>
                {shot.fitMode === 'loop' ? `looped ×${shot.loops}` : 'slowed to fit'}
              </span>
            )}
          </div>

          <p className="mt-2.5 text-sm leading-relaxed text-ink-dim">
            {shot.text ? <>“{highlightName(shot.text, shot.entityName)}”</> : <span className="text-ink-faint">no speech under this shot</span>}
          </p>

          <p className="mt-2.5 text-xs text-ink-faint">
            Cut here because: <span className="text-ink-dim">{shot.reason}</span>
          </p>
        </div>

        <div>
          <label className="label">Source clip</label>
          <select
            className="field mt-1.5"
            value={shot.clipId}
            onChange={(e) => onSwapClip(index, e.target.value)}
          >
            {sameCharacter.length > 0 && (
              <optgroup label={shot.entityName ?? 'This character'}>
                {sameCharacter.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.filename}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Other footage">
              {others.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.filename}
                </option>
              ))}
            </optgroup>
          </select>

          {clip && (
            <p className="mono mt-2 text-[11px] text-ink-faint">
              {clip.width}×{clip.height} · {(clip.durationMs / 1000).toFixed(1)}s source · in at{' '}
              {(shot.sourceInMs / 1000).toFixed(2)}s
            </p>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
            Swapping the clip never moves the cut — the timing comes from where the name is spoken.
          </p>
        </div>
      </div>
    </div>
  );
}

/** Emphasise the character's name inside the spoken line. */
function highlightName(text: string, name: string | null) {
  if (!name) return text;

  const first = name.split(/\s+/)[0];
  if (first.length < 3) return text;

  // Split on the name, keeping the delimiter, so it can be styled in place.
  const parts = text.split(new RegExp(`(${escapeRegExp(first)}\\w*)`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase().startsWith(first.toLowerCase()) ? (
      <strong key={i} className="font-semibold text-ink">
        {part}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
