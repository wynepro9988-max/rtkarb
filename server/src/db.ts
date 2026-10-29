import { readFileSync } from 'node:fs';
import pg from 'pg';

// bigint/numeric sebagai number (nominal rupiah < 2^53), date sebagai 'YYYY-MM-DD'
// agar tidak bergeser zona waktu.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

export type Pool = pg.Pool;

// SSL ke database terkelola (mis. Supabase). Sertifikat diverifikasi memakai CA yang
// diberikan lewat DB_SSL_CA (isi PEM) atau DB_SSL_CA_FILE (path). DB_SSL=no-verify hanya
// untuk diagnosis sementara dan tidak disarankan.
export function sslFromEnv(env: NodeJS.ProcessEnv = process.env): pg.ConnectionConfig['ssl'] {
  const ca = env.DB_SSL_CA ?? (env.DB_SSL_CA_FILE ? readFileSync(env.DB_SSL_CA_FILE, 'utf8') : undefined);
  if (ca) return { ca: ca.replace(/\\n/g, '\n'), rejectUnauthorized: true };
  if (env.DB_SSL === 'no-verify') return { rejectUnauthorized: false };
  if (env.DB_SSL === 'require') return { rejectUnauthorized: true };
  return undefined;
}

export function createPool(connectionString: string, opts: { max?: number; ssl?: pg.ConnectionConfig['ssl'] } = {}): Pool {
  return new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    ssl: opts.ssl ?? sslFromEnv(),
    // Pendek: cocok untuk serverless dan pooler Supabase (mode transaksi).
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'rtka-app',
  });
}

const camel = (key: string) => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function camelize<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) out[camel(key)] = row[key];
  return out as T;
}

export class Db {
  readonly client: pg.PoolClient;

  constructor(client: pg.PoolClient) {
    this.client = client;
  }

  async many<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.client.query(sql, params);
    return res.rows.map((r) => camelize<T>(r));
  }

  async maybe<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.many<T>(sql, params);
    return rows[0] ?? null;
  }

  async one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
    const row = await this.maybe<T>(sql, params);
    if (!row) throw new Error('Query diharapkan mengembalikan satu baris');
    return row;
  }

  async exec(sql: string, params: unknown[] = []): Promise<number> {
    const res = await this.client.query(sql, params);
    return res.rowCount ?? 0;
  }
}

export interface TxOptions {
  readOnly?: boolean;
  // Pengaturan konteks transaksi (app.*) untuk kebijakan RLS. Selalu lokal
  // terhadap transaksi sehingga tidak bocor ke permintaan lain di pool.
  settings?: Record<string, string | null | undefined>;
}

export async function withTx<T>(pool: Pool, opts: TxOptions, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query(opts.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    const entries = Object.entries(opts.settings ?? {});
    if (entries.length > 0) {
      const params: string[] = [];
      const calls = entries.map(([name, value], i) => {
        params.push(name, value ?? '');
        return `set_config($${i * 2 + 1}, $${i * 2 + 2}, true)`;
      });
      await client.query(`SELECT ${calls.join(', ')}`, params);
    }
    const result = await fn(new Db(client));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

// Aplikasi web tidak boleh berjalan dengan role yang melewati RLS.
export async function assertSafeAppRole(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean; owned: number }>(
    `SELECT r.rolsuper, r.rolbypassrls,
            (SELECT count(*)::int FROM pg_tables t WHERE t.schemaname = 'public' AND t.tableowner = current_user) AS owned
       FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const role = rows[0];
  if (!role || role.rolsuper || role.rolbypassrls || role.owned > 0) {
    throw new Error(
      'Koneksi DATABASE_URL memakai role yang dapat melewati Row-Level Security ' +
        '(superuser, BYPASSRLS, atau pemilik tabel). Gunakan role aplikasi rtka_app.',
    );
  }
}
