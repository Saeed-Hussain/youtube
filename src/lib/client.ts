'use client';

import type { Job, ProgressSnapshot } from './jobs';

export interface SystemInfo {
  ready: boolean;
  ffmpeg?: string;
  encoder?: string;
  hardwareAccelerated?: boolean;
  cores: number;
  concurrency?: number;
  error?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    throw new Error(body?.error ?? `Request failed (${res.status}).`);
  }
  return body as T;
}

export const api = {
  system: () => request<SystemInfo & { ok: true }>('/api/system'),

  createJob: () => request<{ job: Job }>('/api/jobs', { method: 'POST' }),

  getJob: (id: string) => request<{ job: Job; rendering: boolean }>(`/api/jobs/${id}`),

  /** ~200 bytes, safe to poll several times a second during a render. */
  progress: (id: string) => request<{ progress: ProgressSnapshot }>(`/api/jobs/${id}/progress`),

  analyse: (id: string, settings: Record<string, unknown>) =>
    request<{ job: Job }>(`/api/jobs/${id}/analyse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }),

  render: (id: string, profile: Record<string, unknown>) =>
    request<{ job: Job }>(`/api/jobs/${id}/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile),
    }),

  setTags: (id: string, clipId: string, tags: string[]) =>
    request<{ job: Job }>(`/api/jobs/${id}/clips/${clipId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags }),
    }),

  setShotClip: (id: string, shotIndex: number, clipId: string) =>
    request<{ job: Job }>(`/api/jobs/${id}/shots`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotIndex, clipId }),
    }),

  deleteClip: (id: string, clipId: string) =>
    request<{ job: Job }>(`/api/jobs/${id}/upload?clipId=${encodeURIComponent(clipId)}`, {
      method: 'DELETE',
    }),
};

/**
 * Upload one file with progress.
 *
 * XHR rather than fetch because fetch still cannot report upload progress in
 * any browser, and a 300MB clip uploading with no feedback is indistinguishable
 * from a hung page.
 */
export function uploadFile(
  jobId: string,
  kind: 'clip' | 'voiceover' | 'subtitles',
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<Job> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ kind, name: file.name });
    const xhr = new XMLHttpRequest();

    xhr.open('PUT', `/api/jobs/${jobId}/upload?${params}`);
    xhr.responseType = 'json';

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };

    xhr.onload = () => {
      const body = xhr.response as { ok?: boolean; job?: Job; error?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.ok && body.job) resolve(body.job);
      else reject(new Error(body?.error ?? `Upload failed (${xhr.status}).`));
    };

    xhr.onerror = () => reject(new Error(`Upload of "${file.name}" failed - the connection dropped.`));
    xhr.onabort = () => reject(new Error('Upload cancelled.'));

    xhr.send(file);
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
