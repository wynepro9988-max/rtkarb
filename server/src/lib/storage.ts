import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StorageConfig } from '../config.ts';

// Penyimpanan berkas pasien. Kunci berbentuk "<organization_id>/<uuid>.<ext>" dan selalu
// dibuat oleh server. Berkas hanya keluar lewat endpoint terotorisasi.
export interface FileStore {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

function assertKey(key: string) {
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|jpg|png)$/.test(key)) throw new Error('Kunci penyimpanan tidak valid');
}

// Disk lokal (pengembangan / VPS). Folder di luar web root, izin 0700/0600.
export class LocalFileStore implements FileStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private full(key: string) {
    assertKey(key);
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('Kunci penyimpanan tidak valid');
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.full(key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.part`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, target);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.full(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.full(key), { force: true });
  }
}

// Supabase Storage melalui REST API (bucket privat). Kunci rahasia hanya ada di server.
export class SupabaseFileStore implements FileStore {
  readonly baseUrl: string;
  readonly bucket: string;
  readonly headers: Record<string, string>;

  constructor(url: string, key: string, bucket: string) {
    this.baseUrl = `${url.replace(/\/$/, '')}/storage/v1/object`;
    this.bucket = bucket;
    // Kunci model baru (sb_secret_...) dikirim di header apikey; kunci JWT lama (service_role)
    // juga sebagai Bearer.
    this.headers = key.startsWith('sb_secret_') ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` };
  }

  private url(key: string, prefix = '') {
    assertKey(key);
    return `${this.baseUrl}/${prefix}${encodeURIComponent(this.bucket)}/${key}`;
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    const res = await fetch(this.url(key), {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': contentType, 'x-upsert': 'false', 'Cache-Control': 'no-store' },
      body: new Uint8Array(data),
    });
    if (!res.ok) throw new Error(`Supabase Storage menolak unggahan (HTTP ${res.status})`);
  }

  async get(key: string): Promise<Buffer> {
    const res = await fetch(this.url(key, 'authenticated/'), { headers: this.headers });
    if (!res.ok) throw new Error(`Supabase Storage gagal mengirim berkas (HTTP ${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  async remove(key: string): Promise<void> {
    const res = await fetch(this.url(key), { method: 'DELETE', headers: this.headers });
    if (!res.ok && res.status !== 404) throw new Error(`Supabase Storage gagal menghapus berkas (HTTP ${res.status})`);
  }
}

export function createFileStore(cfg: StorageConfig): FileStore {
  if (cfg.driver === 'supabase') return new SupabaseFileStore(cfg.supabaseUrl!, cfg.supabaseKey!, cfg.bucket);
  return new LocalFileStore(cfg.uploadDir);
}
