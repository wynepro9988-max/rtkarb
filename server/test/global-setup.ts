import pg from 'pg';
import { migrate } from '../scripts/migrate.ts';
import { testUrls } from './env.ts';

// Membuat ulang database uji (hanya *_test di localhost) lalu menjalankan seluruh migrasi.
export async function setup() {
  const { adminUrl } = testUrls();
  const target = new URL(adminUrl);
  const dbName = target.pathname.slice(1);
  const maintenance = new URL(adminUrl);
  maintenance.pathname = '/postgres';

  const client = new pg.Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(dbName)}`);
    await client.query(`CREATE DATABASE ${pg.escapeIdentifier(dbName)}`);
    await client.query(`REVOKE ALL ON DATABASE ${pg.escapeIdentifier(dbName)} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${pg.escapeIdentifier(dbName)} TO rtka_app`);
  } finally {
    await client.end();
  }

  // Simulasi Supabase ("Automatically expose new tables"): role Data API diberi hak default atas
  // objek baru sebelum migrasi. Migrasi 004 wajib mencabutnya (lihat supabase.test.ts).
  const owner = new pg.Client({ connectionString: adminUrl });
  await owner.connect();
  try {
    const { rows } = await owner.query(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`);
    if (rows[0].n === 2) {
      await owner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated`);
      await owner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated`);
      await owner.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated`);
    }
  } finally {
    await owner.end();
  }
  await migrate(adminUrl, () => {});
}
