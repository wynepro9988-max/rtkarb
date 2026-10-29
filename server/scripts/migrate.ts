// Menjalankan migrasi SQL berurutan dengan role pemilik skema (DATABASE_ADMIN_URL).
// Migrasi yang sudah diterapkan dicatat beserta checksum; perubahan isi file lama ditolak.
//   node server/scripts/migrate.ts          -> database pengembangan/produksi
//   node server/scripts/migrate.ts --test   -> TEST_DATABASE_ADMIN_URL
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { sslFromEnv } from '../src/db.ts';

const LOCK_KEY = 727274;

export async function migrate(connectionString: string, log: (msg: string) => void = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString, ssl: sslFromEnv(), application_name: 'rtka-migrate' });
  await client.connect();
  const appliedNow: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const dir = path.resolve(import.meta.dirname, '../migrations');
    const files = (await readdir(dir)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
    const { rows } = await client.query<{ version: string; checksum: string }>('SELECT version, checksum FROM schema_migrations');
    const applied = new Map(rows.map((r) => [r.version, r.checksum]));

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(file);
      if (previous) {
        if (previous !== checksum) {
          throw new Error(`Migrasi ${file} sudah diterapkan tetapi isinya berubah. Buat file migrasi baru, jangan ubah yang lama.`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migrasi ${file} gagal: ${(err as Error).message}`);
      }
      appliedNow.push(file);
      log(`  diterapkan: ${file}`);
    }
    if (appliedNow.length === 0) log('  skema sudah mutakhir');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await client.end();
  }
  return appliedNow;
}

if (import.meta.main) {
  const test = process.argv.includes('--test');
  const url = test ? process.env.TEST_DATABASE_ADMIN_URL : process.env.DATABASE_ADMIN_URL;
  if (!url) {
    console.error(`${test ? 'TEST_DATABASE_ADMIN_URL' : 'DATABASE_ADMIN_URL'} belum diisi`);
    process.exit(1);
  }
  console.log(`Migrasi database (${new URL(url).pathname.slice(1)})`);
  migrate(url).catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
