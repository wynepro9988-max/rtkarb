// Mengunduh semua berkas pasien dari penyimpanan aktif (disk lokal atau Supabase Storage)
// ke sebuah folder, untuk disertakan dalam backup (scripts/backup.sh memanggil skrip ini).
// Daftar berkas diambil dari tabel patient_documents memakai DATABASE_ADMIN_URL.
//   node server/scripts/storage-export.ts --out <folder>
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { loadConfig } from '../src/config.ts';
import { sslFromEnv } from '../src/db.ts';
import { createFileStore } from '../src/lib/storage.ts';

const { values } = parseArgs({ options: { out: { type: 'string' } } });
if (!values.out) {
  console.error('--out <folder> wajib diisi');
  process.exit(1);
}
const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!adminUrl) {
  console.error('DATABASE_ADMIN_URL belum diisi');
  process.exit(1);
}

const store = createFileStore(loadConfig().storage);
const client = new pg.Client({ connectionString: adminUrl, ssl: sslFromEnv(), application_name: 'rtka-storage-export' });
await client.connect();
const { rows } = await client.query<{ storage_key: string; size_bytes: number; sha256: string }>(
  `SELECT storage_key, size_bytes, sha256 FROM patient_documents ORDER BY uploaded_at`,
);
await client.end();

let failed = 0;
for (const r of rows) {
  try {
    const data = await store.get(r.storage_key);
    const target = path.join(values.out, r.storage_key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, data, { mode: 0o600 });
  } catch (err) {
    failed++;
    console.error(`Gagal mengunduh ${r.storage_key}: ${(err as Error).message}`);
  }
}
console.log(`${rows.length - failed} dari ${rows.length} berkas diekspor ke ${values.out}`);
if (failed) process.exit(1);
