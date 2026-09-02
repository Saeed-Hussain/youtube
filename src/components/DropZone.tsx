'use client';

import { useCallback, useRef, useState } from 'react';
import clsx from 'clsx';

interface Props {
  label: string;
  hint: string;
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  done?: boolean;
  onFiles: (files: File[]) => void;
}

/**
 * A drop target that doubles as a file picker.
 *
 * `dragenter` and `dragleave` fire for every child element the pointer crosses,
 * so a naive boolean flickers as you move across the zone's own contents.
 * Counting enters against leaves is the standard fix.
 */
export function DropZone({ label, hint, accept, multiple, disabled, done, onFiles }: Props) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  const open = () => !disabled && input.current?.click();

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      depth.current = 0;
      setActive(false);
      if (disabled) return;
      const files = [...e.dataTransfer.files];
      if (files.length) onFiles(multiple ? files : files.slice(0, 1));
    },
    [disabled, multiple, onFiles],
  );

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current++;
        if (!disabled) setActive(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        if (--depth.current <= 0) setActive(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
      className={clsx(
        'group relative flex cursor-pointer items-center gap-3 rounded-lg border px-3.5 py-3 text-left transition-colors',
        active
          ? 'border-accent bg-accent/10'
          : done
            ? 'border-line bg-white shadow-[0_1px_2px_rgba(20,23,30,0.05)] hover:border-[#c7cedb] hover:shadow-[0_2px_6px_-1px_rgba(20,23,30,0.09)]'
            : 'border-dashed border-line bg-surface-2/60 shadow-[inset_0_1px_2px_rgba(20,23,30,0.04)] hover:border-[#c7cedb] hover:bg-surface-2',
        disabled && 'pointer-events-none opacity-40',
      )}
    >
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length) onFiles(files);
          // Reset so re-picking the same file still fires a change event.
          e.target.value = '';
        }}
      />

      <span
        className={clsx(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs transition-colors',
          done
            ? 'bg-good/15 text-good shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]'
            : 'bg-surface-3 text-ink-faint shadow-[inset_0_1px_2px_rgba(20,23,30,0.07)] group-hover:text-ink-dim',
        )}
      >
        {done ? '✓' : '+'}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-ink">{label}</span>
        <span className="mt-0.5 block truncate text-[11px] text-ink-faint">{hint}</span>
      </span>
    </div>
  );
}
