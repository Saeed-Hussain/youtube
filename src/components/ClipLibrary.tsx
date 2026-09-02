'use client';

import { useState } from 'react';
import clsx from 'clsx';
import type { Job } from '@/lib/jobs';
import { formatDuration } from '@/lib/client';
import { useLaneColours } from './Timeline';

interface Props {
  job: Job;
  busy: boolean;
  onRetag: (clipId: string, tags: string[]) => void;
  onRemove: (clipId: string) => void;
}

/**
 * The footage, grouped by the character each file names.
 *
 * Grouping rather than listing is deliberate: the filenames *are* the cast, so
 * the list should show what the system read out of them. A character sitting
 * under a "B-roll" heading when you expected them under their own name is the
 * single most common mistake, and grouping makes it obvious instantly.
 */
export function ClipLibrary({ job, busy, onRetag, onRemove }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const colours = useLaneColours(job);

  if (!job.clips.length) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm text-ink-dim">No footage yet</p>
        <p className="mt-1 text-xs text-ink-faint">Name files after the character: drake_court_01.mp4</p>
      </div>
    );
  }

  const groups = job.entities
    .map((entity) => ({
      key: entity.id,
      label: entity.canonical,
      colour: colours.get(entity.id),
      clips: job.clips.filter((c) => c.entityIds.includes(entity.id)),
    }))
    .filter((g) => g.clips.length);

  const unbound = job.clips.filter((c) => c.entityIds.length === 0);
  if (unbound.length) groups.push({ key: '__broll', label: 'B-roll', colour: undefined, clips: unbound });

  const startEditing = (clipId: string, tags: string[]) => {
    setDraft(tags.join(', '));
    setEditing(clipId);
  };

  const commit = (clipId: string) => {
    onRetag(clipId, draft.split(',').map((t) => t.trim()).filter(Boolean));
    setEditing(null);
  };

  return (
    <div className="divide-y divide-line-soft">
      {groups.map((group) => (
        <div key={group.key} className="px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <span
              className="h-2 w-2 rounded-sm"
              style={{ background: group.colour ?? 'var(--surface-3)' }}
            />
            <span className="text-xs font-semibold text-ink-dim">{group.label}</span>
            <span className="mono text-[11px] text-ink-faint">{group.clips.length}</span>
          </div>

          <ul className="space-y-1.5">
            {group.clips.map((clip) => (
              <li key={clip.id} className="group flex items-center gap-2.5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/jobs/${job.id}/thumb/${clip.id}`}
                  alt=""
                  className="h-9 w-16 shrink-0 rounded border border-line bg-black object-cover shadow-[0_1px_2px_rgba(20,23,30,0.14)]"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.opacity = '0';
                  }}
                />

                <div className="min-w-0 flex-1">
                  {editing === clip.id ? (
                    <input
                      autoFocus
                      className="field py-1 text-xs"
                      value={draft}
                      placeholder="Character name"
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => commit(clip.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commit(clip.id);
                        if (e.key === 'Escape') setEditing(null);
                      }}
                    />
                  ) : (
                    <>
                      <p className="truncate text-xs text-ink" title={clip.filename}>
                        {clip.filename}
                      </p>
                      <p className="mono mt-0.5 text-[10px] text-ink-faint">
                        {formatDuration(clip.durationMs)} · {clip.width}×{clip.height}
                        {clip.tags.length ? ` · tagged ${clip.tags.join(', ')}` : ''}
                      </p>
                    </>
                  )}
                </div>

                <div className={clsx('flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100', busy && 'pointer-events-none')}>
                  <button
                    className="rounded px-1.5 py-0.5 text-[10px] text-ink-faint hover:bg-surface-3 hover:text-ink"
                    onClick={() => startEditing(clip.id, clip.tags)}
                    title="Override the character this clip belongs to"
                  >
                    tag
                  </button>
                  <button
                    className="rounded px-1.5 py-0.5 text-[10px] text-ink-faint hover:bg-surface-3 hover:text-bad"
                    onClick={() => onRemove(clip.id)}
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
