'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';

import { api, formatBytes, formatDuration, uploadFile, type SystemInfo } from '@/lib/client';
import type { Job } from '@/lib/jobs';
import { DropZone } from '@/components/DropZone';
import { ClipLibrary } from '@/components/ClipLibrary';
import { CastPanel } from '@/components/CastPanel';
import { Timeline } from '@/components/Timeline';
import { ShotInspector } from '@/components/ShotInspector';

interface UploadState {
  name: string;
  fraction: number;
}

const RESOLUTIONS = [
  { label: '1080p · 1920×1080', width: 1920, height: 1080 },
  { label: '720p · 1280×720', width: 1280, height: 720 },
  { label: '1440p · 2560×1440', width: 2560, height: 1440 },
  { label: 'Vertical · 1080×1920', width: 1080, height: 1920 },
] as const;

/** Cutting styles, as three presets rather than four raw millisecond fields. */
const PACING = [
  { id: 'rapid', label: 'Rapid', hint: 'Cut on every name', minNamedMs: 400, minBrollMs: 1400, maxDurationMs: 4500 },
  { id: 'balanced', label: 'Balanced', hint: 'Recommended', minNamedMs: 600, minBrollMs: 2000, maxDurationMs: 7000 },
  { id: 'relaxed', label: 'Relaxed', hint: 'Longer holds', minNamedMs: 1000, minBrollMs: 3000, maxDurationMs: 11000 },
] as const;

export default function Page() {
  const [job, setJob] = useState<Job | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [selectedShot, setSelectedShot] = useState<number | null>(null);

  const [names, setNames] = useState('');
  const [pacing, setPacing] = useState<(typeof PACING)[number]['id']>('balanced');
  const [carryForward, setCarryForward] = useState(true);

  const [resolution, setResolution] = useState(0);
  const [fps, setFps] = useState(30);
  const [quality, setQuality] = useState(21);
  const [fill, setFill] = useState<'pad' | 'crop'>('pad');

  const jobId = job?.id ?? null;
  const rendering = job?.progress.stage === 'rendering';

  /* --- bootstrap ----------------------------------------------------- */
  useEffect(() => {
    api
      .system()
      .then(setSystem)
      .catch(() => setSystem({ ready: false, cores: 0, error: 'Could not reach the server.' }));
    api
      .createJob()
      .then((r) => setJob(r.job))
      .catch((e) => setError(e.message));
  }, []);

  /* --- progress polling ----------------------------------------------- */
  // Polls the tiny progress sidecar, not the whole manifest: pulling the full
  // shot list several times a second would ship ~150KB per poll on a long
  // video and re-render every panel on the page for the sake of two numbers.
  // The full job is refetched exactly once, when the render stops.
  useEffect(() => {
    if (!jobId || !rendering) return;

    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const { progress } = await api.progress(jobId);
        if (cancelled) return;

        if (progress.stage === 'rendering') {
          setJob((current) => (current ? { ...current, progress } : current));
          return;
        }

        // Terminal state: now the manifest is worth pulling, for the output
        // details and the log lines the render appended.
        const { job: fresh } = await api.getJob(jobId);
        if (!cancelled) setJob(fresh);
      } catch {
        /* a dropped poll is harmless - the next one catches up */
      }
    }, 600);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobId, rendering]);

  const analyseSettings = useMemo(() => {
    const preset = PACING.find((p) => p.id === pacing) ?? PACING[1];
    return {
      declaredNames: names.split(',').map((n) => n.trim()).filter(Boolean),
      minNamedMs: preset.minNamedMs,
      minBrollMs: preset.minBrollMs,
      maxDurationMs: preset.maxDurationMs,
      carryForward,
    };
  }, [names, pacing, carryForward]);

  const guard = useCallback(async (label: string, fn: () => Promise<Job | void>) => {
    setError(null);
    setBusy(label);
    try {
      const result = await fn();
      if (result) setJob(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const handleUpload = useCallback(
    async (kind: 'clip' | 'voiceover' | 'subtitles', files: File[]) => {
      if (!jobId) return;
      setError(null);

      // Sequential on purpose: parallel uploads of several hundred-megabyte
      // clips saturate the link and make every progress bar crawl, which reads
      // as a hang.
      for (const file of files) {
        setUploads((u) => [...u, { name: file.name, fraction: 0 }]);
        try {
          const updated = await uploadFile(jobId, kind, file, (fraction) =>
            setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, fraction } : x))),
          );
          setJob(updated);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setUploads((u) => u.filter((x) => x.name !== file.name));
        }
      }
    },
    [jobId],
  );

  const analyse = useCallback(() => {
    if (!jobId) return;
    setSelectedShot(null);
    return guard('analyse', async () => (await api.analyse(jobId, analyseSettings)).job);
  }, [jobId, guard, analyseSettings]);

  const render = useCallback(() => {
    if (!jobId) return;
    const res = RESOLUTIONS[resolution];
    return guard('render', async () => {
      const { job: fresh } = await api.render(jobId, {
        width: res.width,
        height: res.height,
        fps,
        quality,
        fill,
        encoder: 'auto',
      });
      return fresh;
    });
  }, [jobId, guard, resolution, fps, quality, fill]);

  const hasSubtitles = Boolean(job?.subtitles);
  const hasClips = Boolean(job?.clips.length);
  const canAnalyse = hasSubtitles && hasClips && !busy && !rendering;
  const canRender = Boolean(job?.shots.length) && !busy && !rendering;
  const progress = job?.progress;

  const step = hasSubtitles && hasClips ? (job?.shots.length ? 3 : 2) : 1;

  return (
    <main className="mx-auto max-w-[1560px] px-6 py-6">
      {/* ================= header ================= */}
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-b from-white to-surface-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_1px_2px_rgba(20,23,30,0.10),0_3px_8px_-3px_rgba(20,23,30,0.14)] ring-1 ring-inset ring-line">
            <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden>
              <rect x="1.5" y="4" width="17" height="12" rx="2" stroke="var(--accent)" strokeWidth="1.6" />
              <path d="M6 4v12M14 4v12" stroke="var(--accent)" strokeWidth="1.6" />
            </svg>
          </div>
          <div>
            <h1 className="text-[15px] font-semibold leading-tight text-ink">ClipForge</h1>
            <p className="text-[11px] leading-tight text-ink-faint">
              Your clip filenames are the cast. Cuts land where the names are spoken.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <StepRail step={step} />
          <SystemBadge system={system} />
        </div>
      </header>

      {error && (
        <Banner tone="bad" onDismiss={() => setError(null)}>
          {error}
        </Banner>
      )}
      {system && !system.ready && (
        <Banner tone="warn">FFmpeg was not found, so rendering will fail. {system.error}</Banner>
      )}

      <div className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)_320px]">
        {/* ================= left: inputs ================= */}
        <div className="space-y-5">
          <section className="surface surface-lit">
            <div className="panel-head">
              <span className="panel-title">Source</span>
              {job && <span className="mono text-[10px] text-ink-faint">{job.id.slice(0, 8)}</span>}
            </div>

            <div className="space-y-2 p-3">
              <DropZone
                label={job?.subtitles ? job.subtitles.filename : 'Subtitle file'}
                hint={
                  job?.subtitles?.cueCount
                    ? `${job.subtitles.cueCount} cues · ${job.subtitles.wordCount} words`
                    : '.srt or .vtt — the timing source'
                }
                accept=".srt,.vtt,text/plain"
                done={hasSubtitles}
                disabled={!job || rendering}
                onFiles={(f) => handleUpload('subtitles', f)}
              />

              <DropZone
                label={job?.voiceover ? `Voiceover · ${formatDuration(job.voiceover.durationMs)}` : 'Voiceover'}
                hint="Sets the exact final length"
                accept="audio/*,.mp3,.wav,.m4a,.aac,.flac,.ogg,.opus"
                done={Boolean(job?.voiceover)}
                disabled={!job || rendering}
                onFiles={(f) => handleUpload('voiceover', f)}
              />

              <DropZone
                label={job?.clips.length ? `${job.clips.length} clips` : 'Clips'}
                hint="drake_court_01.mp4 — the filename names the character"
                accept="video/*,.mp4,.mov,.mkv,.webm,.avi,.m4v"
                multiple
                done={hasClips}
                disabled={!job || rendering}
                onFiles={(f) => handleUpload('clip', f)}
              />

              {uploads.map((u) => (
                <div key={u.name} className="px-1 pt-1">
                  <div className="mb-1 flex justify-between text-[10px] text-ink-faint">
                    <span className="truncate">{u.name}</span>
                    <span className="mono">{Math.round(u.fraction * 100)}%</span>
                  </div>
                  <div className="meter h-1 rounded">
                    <div className="h-full bg-accent transition-[width]" style={{ width: `${u.fraction * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="surface surface-lit">
            <div className="panel-head">
              <span className="panel-title">Edit</span>
            </div>

            <div className="space-y-4 p-4">
              <div>
                <span className="label">Pacing</span>
                <div className="mt-1.5 grid grid-cols-3 gap-1 rounded-lg bg-surface-3 p-1 shadow-[inset_0_1px_2px_rgba(20,23,30,0.10)]">
                  {PACING.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setPacing(p.id)}
                      disabled={rendering}
                      title={p.hint}
                      className={clsx(
                        'rounded-md px-2 py-1.5 text-[12px] font-medium transition-colors',
                        pacing === p.id
                          ? 'bg-surface-1 text-ink shadow-[0_1px_2px_rgba(20,23,30,0.10)] ring-1 ring-inset ring-line'
                          : 'text-ink-faint hover:text-ink-dim',
                      )}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1.5 text-[11px] text-ink-faint">
                  {PACING.find((p) => p.id === pacing)?.hint}. Names always win over pacing — three
                  names in one line still get three shots.
                </p>
              </div>

              <label className="flex items-start gap-2.5 text-[13px] text-ink-dim">
                <input
                  type="checkbox"
                  checked={carryForward}
                  onChange={(e) => setCarryForward(e.target.checked)}
                  className="mt-0.5"
                  disabled={rendering}
                />
                <span>
                  Hold through follow-ups
                  <span className="mt-0.5 block text-[11px] text-ink-faint">
                    Stay on a character through “he said…”, “his lawyers…”
                  </span>
                </span>
              </label>

              <label className="block">
                <span className="label">Extra names (optional)</span>
                <input
                  className="field mt-1.5"
                  placeholder="Faisal, UMG"
                  value={names}
                  onChange={(e) => setNames(e.target.value)}
                  disabled={rendering}
                />
                <span className="mt-1 block text-[11px] leading-relaxed text-ink-faint">
                  Only needed for a character with no clip of their own.
                </span>
              </label>

              <button className="btn btn-primary w-full" onClick={analyse} disabled={!canAnalyse}>
                {busy === 'analyse' ? 'Analysing…' : job?.shots.length ? 'Re-analyse' : 'Analyse'}
              </button>
              {!canAnalyse && !rendering && !busy && (
                <p className="text-center text-[11px] text-ink-faint">
                  {!hasSubtitles ? 'Add a subtitle file' : !hasClips ? 'Add at least one clip' : ''}
                </p>
              )}
            </div>
          </section>

          <section className="surface surface-lit">
            <div className="panel-head">
              <span className="panel-title">Output</span>
            </div>

            <div className="space-y-3.5 p-4">
              <div className="grid grid-cols-2 gap-2.5">
                <label className="block">
                  <span className="label">Resolution</span>
                  <select
                    className="field mt-1.5"
                    value={resolution}
                    onChange={(e) => setResolution(Number(e.target.value))}
                    disabled={rendering}
                  >
                    {RESOLUTIONS.map((r, i) => (
                      <option key={r.label} value={i}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="label">Frame rate</span>
                  <select
                    className="field mt-1.5"
                    value={fps}
                    onChange={(e) => setFps(Number(e.target.value))}
                    disabled={rendering}
                  >
                    {[24, 25, 30, 50, 60].map((f) => (
                      <option key={f} value={f}>
                        {f} fps
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block">
                <span className="label">Aspect mismatch</span>
                <select
                  className="field mt-1.5"
                  value={fill}
                  onChange={(e) => setFill(e.target.value as 'pad' | 'crop')}
                  disabled={rendering}
                >
                  <option value="pad">Letterbox — keep everything</option>
                  <option value="crop">Fill — crop the edges</option>
                </select>
              </label>

              <div>
                <div className="flex items-baseline justify-between">
                  <span className="label">Quality</span>
                  <span className="mono text-[11px] text-ink-faint">
                    {quality <= 19 ? 'high' : quality <= 24 ? 'balanced' : 'compact'}
                  </span>
                </div>
                <input
                  type="range"
                  min={16}
                  max={30}
                  value={34 - quality}
                  onChange={(e) => setQuality(34 - Number(e.target.value))}
                  className="mt-1"
                  disabled={rendering}
                />
              </div>

              <button className="btn btn-primary w-full" onClick={render} disabled={!canRender}>
                {rendering ? 'Rendering…' : 'Render'}
              </button>

              {progress && (rendering || progress.stage === 'done') && (
                <div>
                  <div className="mb-1.5 flex justify-between text-[11px]">
                    <span className="text-ink-dim">{progress.label}</span>
                    <span className="mono text-ink-faint">
                      {progress.percent}%
                      {progress.etaMs !== undefined && rendering ? ` · ${formatDuration(progress.etaMs)} left` : ''}
                    </span>
                  </div>
                  <div className="meter h-1.5 rounded">
                    <div
                      className={clsx('h-full transition-[width] duration-300', progress.stage === 'done' ? 'bg-good' : 'bg-accent')}
                      style={{ width: `${progress.percent}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* ================= centre: the edit ================= */}
        <div className="space-y-5">
          {job?.output && (
            <section className="surface surface-lit surface-raised overflow-hidden">
              <div className="panel-head">
                <span className="panel-title">Result</span>
                <span className="mono text-[10px] text-ink-faint">
                  {formatDuration(job.output.durationMs)} · {formatBytes(job.output.sizeBytes)} ·{' '}
                  {(job.output.renderMs / 1000).toFixed(1)}s to render
                </span>
              </div>
              <video
                key={job.output.renderMs}
                src={`/api/jobs/${job.id}/download`}
                controls
                className="aspect-video w-full bg-black"
              />
              <div className="p-3">
                <a className="btn btn-primary w-full" href={`/api/jobs/${job.id}/download?download=1`} download>
                  Download MP4
                </a>
              </div>
            </section>
          )}

          <section className="surface surface-lit">
            <div className="panel-head">
              <span className="panel-title">Edit timeline</span>
              {job?.shots.length ? (
                <span className="text-[10px] text-ink-faint">click a block to inspect or swap</span>
              ) : null}
            </div>

            {job && <Timeline job={job} selected={selectedShot} onSelect={setSelectedShot} />}

            {job && selectedShot !== null && (
              <ShotInspector
                job={job}
                index={selectedShot}
                onClose={() => setSelectedShot(null)}
                onStep={(delta) =>
                  setSelectedShot((i) =>
                    i === null ? null : Math.max(0, Math.min(job.shots.length - 1, i + delta)),
                  )
                }
                onSwapClip={(i, clipId) =>
                  guard('swap', async () => (await api.setShotClip(job.id, i, clipId)).job)
                }
              />
            )}
          </section>

          {job && (job.warnings.length > 0 || job.notes.length > 0) && (
            <section className="surface surface-lit">
              <div className="panel-head">
                <span className="panel-title">Notes</span>
              </div>
              <ul className="space-y-2 p-4 text-[12px] leading-relaxed">
                {job.warnings.map((w, i) => (
                  <li key={`w${i}`} className="flex gap-2 text-warn">
                    <span className="shrink-0">▲</span>
                    <span>{w}</span>
                  </li>
                ))}
                {job.notes.map((n, i) => (
                  <li key={`n${i}`} className="flex gap-2 text-ink-faint">
                    <span className="shrink-0">·</span>
                    <span>{n}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {job && job.logs.length > 0 && (
            <section className="surface surface-lit">
              <div className="panel-head">
                <span className="panel-title">Log</span>
              </div>
              <div className="max-h-56 overflow-y-auto px-4 py-3">
                <ul className="mono space-y-1 text-[11px] leading-relaxed">
                  {job.logs.slice(-60).map((l, i) => (
                    <li
                      key={i}
                      className={clsx(
                        l.level === 'error' && 'text-bad',
                        l.level === 'warn' && 'text-warn',
                        l.level === 'success' && 'text-good',
                        l.level === 'info' && 'text-ink-faint',
                      )}
                    >
                      {l.message}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}
        </div>

        {/* ================= right: cast & footage ================= */}
        <div className="space-y-5">
          <section className="surface surface-lit">
            <div className="panel-head">
              <span className="panel-title">Cast</span>
              {job?.entities.length ? (
                <span className="mono text-[10px] text-ink-faint">{job.entities.length}</span>
              ) : null}
            </div>
            {job && <CastPanel job={job} />}
          </section>

          <section className="surface surface-lit">
            <div className="panel-head">
              <span className="panel-title">Footage</span>
              {job?.clips.length ? (
                <span className="mono text-[10px] text-ink-faint">{job.clips.length}</span>
              ) : null}
            </div>
            {job && (
              <ClipLibrary
                job={job}
                busy={Boolean(busy) || rendering}
                onRetag={(clipId, tags) =>
                  guard('retag', async () => {
                    await api.setTags(job.id, clipId, tags);
                    return (await api.analyse(job.id, analyseSettings)).job;
                  })
                }
                onRemove={(clipId) => guard('remove', async () => (await api.deleteClip(job.id, clipId)).job)}
              />
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ */

function StepRail({ step }: { step: number }) {
  const steps = ['Source', 'Analyse', 'Render'];
  return (
    <div className="hidden items-center gap-2 md:flex">
      {steps.map((label, i) => {
        const n = i + 1;
        const state = n < step ? 'done' : n === step ? 'current' : 'todo';
        return (
          <div key={label} className="flex items-center gap-2">
            <span
              className={clsx(
                'flex h-4.5 w-4.5 items-center justify-center rounded-full text-[9px] font-semibold',
                state === 'done' && 'bg-good/20 text-good',
                state === 'current' && 'bg-accent text-white',
                state === 'todo' && 'bg-surface-3 text-ink-faint',
              )}
              style={{ height: 18, width: 18 }}
            >
              {state === 'done' ? '✓' : n}
            </span>
            <span className={clsx('text-[11px]', state === 'todo' ? 'text-ink-faint' : 'text-ink-dim')}>
              {label}
            </span>
            {i < steps.length - 1 && <span className="h-px w-5 bg-line" />}
          </div>
        );
      })}
    </div>
  );
}

function SystemBadge({ system }: { system: SystemInfo | null }) {
  if (!system) return <span className="text-[11px] text-ink-faint">checking…</span>;

  return (
    <div className="flex items-center gap-1.5">
      <span
        className="chip"
        style={
          system.ready
            ? { borderColor: 'color-mix(in srgb, var(--good) 40%, transparent)', color: 'var(--good)' }
            : { borderColor: 'color-mix(in srgb, var(--bad) 40%, transparent)', color: 'var(--bad)' }
        }
        title={system.ffmpeg ?? system.error}
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: 'currentColor' }} />
        {system.ready ? 'FFmpeg' : 'No FFmpeg'}
      </span>
      {system.ready && (
        <span className="chip">
          {system.hardwareAccelerated ? `${system.encoder} · GPU` : 'x264 · CPU'} · {system.concurrency}×
        </span>
      )}
    </div>
  );
}

function Banner({
  tone,
  children,
  onDismiss,
}: {
  tone: 'bad' | 'warn';
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div
      className="mb-4 flex items-start gap-3 rounded-lg border px-4 py-3 text-[13px]"
      style={{
        borderColor: `color-mix(in srgb, var(--${tone}) 35%, transparent)`,
        background: `color-mix(in srgb, var(--${tone}) 10%, transparent)`,
        color: `var(--${tone})`,
      }}
    >
      <span className="flex-1">{children}</span>
      {onDismiss && (
        <button onClick={onDismiss} className="shrink-0 opacity-60 hover:opacity-100">
          ✕
        </button>
      )}
    </div>
  );
}
