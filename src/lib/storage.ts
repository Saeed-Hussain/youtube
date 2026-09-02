import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Where a job's files live.
 *
 * Two backends behind one interface. Locally that is the filesystem, which is
 * fast and easy to inspect. On Vercel it has to be Vercel Blob, because a
 * serverless function has no persistent disk and - more importantly - no
 * *shared* disk: the instance that receives an upload is almost never the
 * instance that later renders with it, so anything written to `/tmp` is
 * invisible to the next request.
 *
 * `/tmp` is still used, but only ever as a scratch pad inside a single
 * invocation: download what this call needs, run FFmpeg on it, push the result
 * back to Blob, and assume none of it survives.
 */
export interface StoredObject {
  key: string;
  url: string;
  size: number;
}

export interface StorageAdapter {
  readonly kind: 'local' | 'blob';
  /** Upload a local file and return its retrievable URL. */
  putFile(key: string, localPath: string, contentType?: string): Promise<StoredObject>;
  putBuffer(key: string, data: Buffer | string, contentType?: string): Promise<StoredObject>;
  getJson<T>(key: string): Promise<T | null>;
  putJson(key: string, value: unknown): Promise<void>;
  /** Copy an object to a local path so FFmpeg can read it. */
  fetchTo(key: string, localPath: string): Promise<void>;
  urlFor(key: string): Promise<string | null>;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  removePrefix(prefix: string): Promise<void>;
  list(prefix: string): Promise<StoredObject[]>;
}

/* ------------------------------------------------------------------ */
/* local filesystem                                                    */
/* ------------------------------------------------------------------ */

class LocalStorage implements StorageAdapter {
  readonly kind = 'local' as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private full(key: string): string {
    // Keys are generated internally, but a traversal here would escape the
    // data directory entirely, so it is cheap insurance to reject one.
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(path.resolve(this.root))) {
      throw new Error(`Refusing to access "${key}" outside the data directory.`);
    }
    return resolved;
  }

  async putFile(key: string, localPath: string, _contentType?: string): Promise<StoredObject> {
    const dest = this.full(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (path.resolve(localPath) !== dest) await fs.copyFile(localPath, dest);
    const stat = await fs.stat(dest);
    return { key, url: `/api/files/${encodeURI(key)}`, size: stat.size };
  }

  async putBuffer(key: string, data: Buffer | string, _contentType?: string): Promise<StoredObject> {
    const dest = this.full(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, data);
    const stat = await fs.stat(dest);
    return { key, url: `/api/files/${encodeURI(key)}`, size: stat.size };
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      return JSON.parse(await fs.readFile(this.full(key), 'utf8')) as T;
    } catch {
      return null;
    }
  }

  async putJson(key: string, value: unknown): Promise<void> {
    const dest = this.full(key);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    // Atomic: a reader sees the whole previous file or the whole new one.
    const temp = `${dest}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(value), 'utf8');
    await fs.rename(temp, dest);
  }

  async fetchTo(key: string, localPath: string): Promise<void> {
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.copyFile(this.full(key), localPath);
  }

  async urlFor(key: string): Promise<string | null> {
    return (await this.exists(key)) ? `/api/files/${encodeURI(key)}` : null;
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.full(key));
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.full(key), { force: true });
  }

  async removePrefix(prefix: string): Promise<void> {
    await fs.rm(this.full(prefix), { recursive: true, force: true });
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const dir = this.full(prefix);
    const out: StoredObject[] = [];
    const walk = async (current: string) => {
      const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else {
          const stat = await fs.stat(full);
          const key = path.relative(this.root, full).split(path.sep).join('/');
          out.push({ key, url: `/api/files/${encodeURI(key)}`, size: stat.size });
        }
      }
    };
    await walk(dir);
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Vercel Blob                                                         */
/* ------------------------------------------------------------------ */

class BlobStorage implements StorageAdapter {
  readonly kind = 'blob' as const;

  private async blob() {
    return import('@vercel/blob');
  }

  async putFile(key: string, localPath: string, contentType?: string): Promise<StoredObject> {
    const { put } = await this.blob();
    const stat = await fs.stat(localPath);
    // A Node Readable is an accepted body type, so the file streams up rather
    // than being read into memory: a rendered video can be hundreds of
    // megabytes and a function has a hard memory ceiling.
    const result = await put(key, createReadStream(localPath), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
    });
    return { key, url: result.url, size: stat.size };
  }

  async putBuffer(key: string, data: Buffer | string, contentType?: string): Promise<StoredObject> {
    const { put } = await this.blob();
    const result = await put(key, data, {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType,
    });
    return { key, url: result.url, size: Buffer.byteLength(data as string) };
  }

  async getJson<T>(key: string): Promise<T | null> {
    const url = await this.urlFor(key);
    if (!url) return null;
    // Blob is a CDN; without this a just-written manifest can read back stale.
    const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  }

  async putJson(key: string, value: unknown): Promise<void> {
    const { put } = await this.blob();
    // Manifests are overwritten constantly at a stable URL, and Blob puts a CDN
    // in front with a month-long default TTL. Without a short max-age a render
    // step can read back the previous state and either redo work or lose it, so
    // this is the one place caching has to be suppressed rather than tuned.
    await put(key, JSON.stringify(value), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
      cacheControlMaxAge: 0,
    });
  }

  async fetchTo(key: string, localPath: string): Promise<void> {
    const url = await this.urlFor(key);
    if (!url) throw new Error(`Missing stored file: ${key}`);
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(`Could not download ${key} (${res.status}).`);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(localPath));
  }

  async urlFor(key: string): Promise<string | null> {
    const { head } = await this.blob();
    try {
      return (await head(key)).url;
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.urlFor(key)) !== null;
  }

  async remove(key: string): Promise<void> {
    const { del } = await this.blob();
    await del(key).catch(() => {});
  }

  async removePrefix(prefix: string): Promise<void> {
    const { del } = await this.blob();
    const items = await this.list(prefix);
    if (items.length) await del(items.map((i) => i.url)).catch(() => {});
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const { list } = await this.blob();
    const out: StoredObject[] = [];
    let cursor: string | undefined;

    // Paginated: a long video produces hundreds of segment objects.
    do {
      const page = await list({ prefix, cursor, limit: 1000 });
      for (const b of page.blobs) out.push({ key: b.pathname, url: b.url, size: b.size });
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);

    return out;
  }
}

/* ------------------------------------------------------------------ */

let cached: StorageAdapter | null = null;

/**
 * Pick the backend.
 *
 * The presence of a Blob token is the signal, not `NODE_ENV`: it is exactly the
 * variable Vercel injects when a Blob store is attached, so the app switches
 * automatically on deploy and stays on the filesystem everywhere else.
 */
export function storage(): StorageAdapter {
  if (cached) return cached;

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (token) {
    cached = new BlobStorage();
  } else {
    const root = process.env.CLIPFORGE_DATA ?? path.join(process.cwd(), '.data');
    cached = new LocalStorage(root);
  }
  return cached;
}

export function isServerless(): boolean {
  return Boolean(process.env.VERCEL);
}

/** A scratch directory that lives only for this invocation. */
export function scratchDir(...parts: string[]): string {
  return path.join(os.tmpdir(), 'clipforge', ...parts);
}

export async function clearScratch(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
