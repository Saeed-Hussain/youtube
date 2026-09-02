'use client';

import type { Job } from '@/lib/jobs';
import { useLaneColours } from './Timeline';

interface Props {
  job: Job;
}

/**
 * Who the video is about, read off the clip filenames.
 *
 * The alternate spellings matter enough to show inline: when a transcript
 * writes "Kendrik", the user needs to see that it was recognised and folded
 * into Kendrick. Otherwise the only way to discover a matching failure is to
 * watch the finished video and notice the wrong face.
 */
export function CastPanel({ job }: Props) {
  const colours = useLaneColours(job);

  if (!job.entities.length) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-sm text-ink-dim">No cast yet</p>
        <p className="mx-auto mt-1 max-w-[240px] text-xs leading-relaxed text-ink-faint">
          Characters come from your clip filenames. Analyse to confirm them against the script.
        </p>
      </div>
    );
  }

  const maxMentions = Math.max(...job.entities.map((e) => e.mentionCount), 1);

  return (
    <ul className="divide-y divide-line-soft">
      {job.entities.map((entity) => {
        const clips = job.clips.filter((c) => c.entityIds.includes(entity.id)).length;
        const corrected = job.mentions.filter((m) => m.entityId === entity.id && m.corrected);
        const variants = entity.variants
          .filter((v) => v.text.toLowerCase() !== entity.canonical.toLowerCase())
          .slice(0, 3);

        return (
          <li key={entity.id} className="px-4 py-3">
            <div className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ background: colours.get(entity.id) }}
              />
              <span className="truncate text-sm font-medium text-ink">{entity.canonical}</span>
              <span className="mono ml-auto shrink-0 text-[11px] text-ink-faint">
                {entity.mentionCount}×
              </span>
            </div>

            {/* Share of the narration, so a lead and a passing reference are
                distinguishable without reading the numbers. */}
            <div className="meter mt-2 h-1 rounded-full">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${(entity.mentionCount / maxMentions) * 100}%`,
                  background: colours.get(entity.id),
                }}
              />
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span
                className="chip"
                style={
                  clips === 0
                    ? { borderColor: 'color-mix(in srgb, var(--warn) 40%, transparent)', color: 'var(--warn)' }
                    : undefined
                }
              >
                {clips === 0 ? 'no footage' : `${clips} clip${clips === 1 ? '' : 's'}`}
              </span>

              {entity.mentionCount === 0 && (
                <span
                  className="chip"
                  style={{ borderColor: 'color-mix(in srgb, var(--bad) 40%, transparent)', color: 'var(--bad)' }}
                >
                  never named in the script
                </span>
              )}

              {corrected.length > 0 && (
                <span
                  className="chip"
                  style={{ borderColor: 'color-mix(in srgb, var(--good) 40%, transparent)', color: 'var(--good)' }}
                  title={[...new Set(corrected.map((m) => m.surface))].join(', ')}
                >
                  {corrected.length} spelling{corrected.length === 1 ? '' : 's'} fixed
                </span>
              )}

              {!entity.auto && <span className="chip">typed in</span>}
            </div>

            {variants.length > 0 && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
                written as {variants.map((v) => `“${v.text}” ×${v.count}`).join(', ')}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
