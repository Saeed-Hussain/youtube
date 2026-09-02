'use client';

import type { Job, ProgressSnapshot } from './jobs';
import type { StepResult } from './render';

export interface SystemInfo {
  ready: boolean;
  /** 'blob' means uploads go straight from the browser to storage. */
  storageKind?: 'local' | 'blob';
  storageWritable?: boolean;
  storageError?: string;
  dataPath?: string;
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

  /** Advance a chunked render by one step. */
  renderStep: (id: string) =>
    request<{ result: StepResult }>(`/api/jobs/${id}/render/step`, { method: 'POST' }),

  registerUpload: (id: string, payload: { kind: 'clip' | 'voiceover'; key: string; filename: string; clipId?: string }) =>
    request<{ job: Job }>(`/api/jobs/${id}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

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
 * Upload a file, by whichever route the deployment supports.
 *
 * On a serverless host the browser streams straight to Blob storage, because a
 * function's request body is capped at about 4.5MB and no video clip fits. The
 * server is told about the file afterwards. Locally the file goes through the
 * server, which keeps development a single moving part.
 */
export async function uploadFile(
  jobId: string,
  kind: 'clip' | 'voiceover' | 'subtitles',
  file: File,
  direct: boolean,
  onProgress?: (fraction: number) => void,
): Promise<Job> {
  // Subtitles are kilobytes, so they always take the simple path.
  if (!direct || kind === 'subtitles') {
    return uploadThroughServer(jobId, kind, file, onProgress);
  }

  const { upload } = await import('@vercel/blob/client');
  const clipId = crypto.randomUUID();
  const extension = file.name.match(/(\.[a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() ?? (kind === 'voiceover' ? '.mp3' : '.mp4');
  const key = kind === 'voiceover' ? `jobs/${jobId}/voiceover${extension}` : `jobs/${jobId}/clips/${clipId}${extension}`;

  const blob = await upload(key, file, {
    access: 'public',
    handleUploadUrl: '/api/blob-upload',
    onUploadProgress: ({ percentage }) => onProgress?.(percentage / 100),
  });

  const { job } = await api.registerUpload(jobId, {
    kind,
    key: blob.pathname,
    filename: file.name,
    clipId: kind === 'clip' ? clipId : undefined,
  });
  return job;
}

/**
 * Upload through the server, with progress.
 *
 * XHR rather than fetch because fetch still cannot report upload progress in
 * any browser, and a large file uploading with no feedback is indistinguishable
 * from a hung page.
 */
function uploadThroughServer(
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
