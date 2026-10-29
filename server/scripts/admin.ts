// CLI administrasi platform. Dijalankan oleh operator di server dengan DATABASE_ADMIN_URL
// (role pemilik skema). Semua tindakan dicatat di audit_logs.
//
//   npm run admin -- create-org --name "Rumah Bintang ..." [--timezone Asia/Jakarta] [--patient-prefix RB] [--receipt-prefix KW]
//   npm run admin -- list-orgs
//   npm run admin -- invite-owner --org <id> --email <email> --name "<nama>"
//   npm run admin -- create-platform-admin --email <email> --name "<nama>"
//   npm run admin -- set-org-status --org <id> --status active|inactive
//   npm run admin -- disable-user --email <email>
//   npm run admin -- db-usage
//   npm run admin -- archive-audit --before YYYY-MM-DD --out <file.jsonl.gz>
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { sslFromEnv } from '../src/db.ts';
import { hashPassword, passwordProblem } from '../src/security/password.ts';
import { newToken, sha256Hex } from '../src/security/tokens.ts';

const OWNER_INVITE_HOURS = 72;
const MB = 1024 * 1024;
const fmtMb = (b: number) => `${(b / MB).toFixed(1)} MB`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Input dari pipe (mis. secret manager): baca baris pertama.
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
      rl.close();
      return line;
    }
    return '';
  }
  process.stdout.write(question);
  return new Promise((resolve) => {
    let value = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        process.exit(130);
      } else if (ch === '\u007f') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) fail('DATABASE_ADMIN_URL belum diisi');
  const client = new pg.Client({ connectionString: url, ssl: sslFromEnv(), application_name: 'rtka-admin-cli' });
  await client.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

const cliAudit = (c: pg.Client, orgId: string | null, action: string, entityType: string, entityId: string, meta: object = {}) =>
  c.query(
    `INSERT INTO audit_logs (organization_id, action, entity_type, entity_id, meta, user_agent)
     VALUES ($1, $2, $3, $4, $5, 'admin-cli')`,
    [orgId, action, entityType, entityId, JSON.stringify({ ...meta, operator_os: process.env.USER ?? null })],
  );

const commands: Record<string, (args: Record<string, string | undefined>) => Promise<void>> = {
  async 'create-org'(a) {
    if (!a.name) fail('--name wajib diisi');
    const row = await withAdmin(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO organizations (name, timezone, patient_code_prefix, receipt_prefix)
         VALUES ($1, coalesce($2, 'Asia/Jakarta'), coalesce($3, 'RB'), coalesce($4, 'KW')) RETURNING id`,
        [a.name, a.timezone ?? null, a['patient-prefix'] ?? null, a['receipt-prefix'] ?? null],
      );
      await cliAudit(c, rows[0].id, 'platform.organisasi_dibuat', 'organization', rows[0].id);
      return rows[0];
    });
    console.log(`Organisasi dibuat.\nID (permanen): ${row.id}`);
  },

  async 'list-orgs'() {
    const rows = await withAdmin(async (c) =>
      (
        await c.query(
          `SELECT o.id, o.name, o.status, o.created_at::date AS dibuat,
                  (SELECT count(*) FROM memberships m WHERE m.organization_id = o.id AND m.status = 'active') AS staf_aktif
             FROM organizations o ORDER BY o.created_at`,
        )
      ).rows,
    );
    console.table(rows);
  },

  async 'invite-owner'(a) {
    if (!a.org || !a.email || !a.name) fail('--org, --email, dan --name wajib diisi');
    const email = a.email.trim().toLowerCase();
    const token = newToken();
    await withAdmin(async (c) => {
      const org = await c.query(`SELECT 1 FROM organizations WHERE id = $1 AND status = 'active'`, [a.org]);
      if (org.rowCount === 0) fail('Organisasi tidak ditemukan atau tidak aktif');
      const user = await c.query(`SELECT 1 FROM users WHERE email = $1`, [email]);
      if (user.rowCount) fail('Email ini sudah memiliki akun');
      await c.query(
        `UPDATE account_tokens SET revoked_at = now()
          WHERE organization_id = $1 AND purpose = 'undangan' AND email = $2 AND used_at IS NULL AND revoked_at IS NULL`,
        [a.org, email],
      );
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO account_tokens (organization_id, purpose, token_hash, email, full_name, role, expires_at)
         VALUES ($1, 'undangan', $2, $3, $4, 'owner', now() + make_interval(hours => $5)) RETURNING id`,
        [a.org, sha256Hex(token), email, a.name, OWNER_INVITE_HOURS],
      );
      await cliAudit(c, a.org!, 'platform.owner_diundang', 'invitation', rows[0].id);
    });
    const base = (process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
    console.log(
      `Tautan aktivasi owner (berlaku ${OWNER_INVITE_HOURS} jam, sekali pakai). Kirim hanya kepada owner yang bersangkutan:\n` +
        `${base}/aktivasi#token=${token}`,
    );
  },

  async 'create-platform-admin'(a) {
    if (!a.email || !a.name) fail('--email dan --name wajib diisi');
    const email = a.email.trim().toLowerCase();
    const password = await promptHidden('Kata sandi admin teknis: ');
    const problem = passwordProblem(password, email);
    if (problem) fail(problem);
    if (process.stdin.isTTY && (await promptHidden('Ulangi kata sandi: ')) !== password) fail('Kata sandi tidak sama');
    const hash = await hashPassword(password);
    await withAdmin(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO users (email, full_name, password_hash, platform_role) VALUES ($1, $2, $3, 'platform_admin') RETURNING id`,
        [email, a.name, hash],
      );
      await cliAudit(c, null, 'platform.admin_dibuat', 'user', rows[0].id);
    });
    console.log('Admin teknis platform dibuat. Akun ini tidak memiliki akses data organisasi tanpa persetujuan owner.');
  },

  async 'set-org-status'(a) {
    if (!a.org || !['active', 'inactive'].includes(a.status ?? '')) fail('--org dan --status active|inactive wajib diisi');
    await withAdmin(async (c) => {
      const r = await c.query(`UPDATE organizations SET status = $2 WHERE id = $1`, [a.org, a.status]);
      if (r.rowCount === 0) fail('Organisasi tidak ditemukan');
      if (a.status === 'inactive') {
        await c.query(`UPDATE sessions SET revoked_at = now() WHERE organization_id = $1 AND revoked_at IS NULL`, [a.org]);
      }
      await cliAudit(c, a.org!, 'platform.status_organisasi', 'organization', a.org!, { status: a.status });
    });
    console.log('Status organisasi diperbarui.');
  },

  async 'disable-user'(a) {
    if (!a.email) fail('--email wajib diisi');
    await withAdmin(async (c) => {
      const { rows } = await c.query<{ id: string; organization_id: string | null }>(
        `UPDATE users u SET status = 'disabled' WHERE email = $1
         RETURNING id, (SELECT organization_id FROM memberships m WHERE m.user_id = u.id) AS organization_id`,
        [a.email!.trim().toLowerCase()],
      );
      if (rows.length === 0) fail('Pengguna tidak ditemukan');
      await c.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [rows[0].id]);
      await cliAudit(c, rows[0].organization_id, 'platform.pengguna_dinonaktifkan', 'user', rows[0].id);
    });
    console.log('Pengguna dinonaktifkan dan seluruh sesinya dicabut.');
  },
};

// Kapasitas dibanding batas paket Supabase Free (bisa diubah lewat DB_SIZE_LIMIT_MB dst.).
commands['db-usage'] = async () => {
  const dbLimit = Number(process.env.DB_SIZE_LIMIT_MB ?? 500) * MB;
  const storageLimit = Number(process.env.STORAGE_LIMIT_MB ?? 1024) * MB;
  const quota = Number(process.env.ORG_STORAGE_QUOTA_MB ?? 450) * MB;
  const r = await withAdmin(async (c) => ({
    db: Number((await c.query(`SELECT pg_database_size(current_database()) AS n`)).rows[0].n),
    tables: (
      await c.query(
        `SELECT c.relname AS tabel, pg_total_relation_size(c.oid) AS ukuran, c.reltuples::bigint AS perkiraan_baris
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
          ORDER BY 2 DESC LIMIT 10`,
      )
    ).rows,
    orgs: (
      await c.query(
        `SELECT o.name, coalesce(sum(d.size_bytes), 0)::bigint AS berkas
           FROM organizations o LEFT JOIN patient_documents d ON d.organization_id = o.id
          GROUP BY o.name ORDER BY o.name`,
      )
    ).rows,
  }));
  const pct = (a: number, b: number) => `${((a / b) * 100).toFixed(1)}%`;
  console.log(`Database : ${fmtMb(r.db)} dari ${fmtMb(dbLimit)} (${pct(r.db, dbLimit)})${r.db > dbLimit * 0.8 ? '  <-- PERINGATAN: di atas 80%' : ''}`);
  const files = r.orgs.reduce((n, o) => n + Number(o.berkas), 0);
  console.log(`Berkas   : ${fmtMb(files)} dari ${fmtMb(storageLimit)} (${pct(files, storageLimit)})`);
  for (const o of r.orgs) console.log(`  - ${o.name}: ${fmtMb(Number(o.berkas))} dari kuota ${fmtMb(quota)} (${pct(Number(o.berkas), quota)})`);
  console.log('Tabel terbesar:');
  console.table(r.tables.map((t) => ({ tabel: t.tabel, ukuran: fmtMb(Number(t.ukuran)), perkiraan_baris: Number(t.perkiraan_baris) < 0 ? 'belum dianalisis' : Number(t.perkiraan_baris) })));
};

// Mengekspor audit log lama ke berkas JSONL terkompresi, lalu menghapusnya dari database.
// Hanya berjalan dengan --before eksplisit; pemilik skema saja yang dapat menghapus audit_logs
// (trigger memeriksa flag rtka.allow_audit_purge). Berkas hasil berisi metadata aktivitas:
// simpan terenkripsi dan sesuai kebijakan retensi.
commands['archive-audit'] = async (a) => {
  if (!a.before || !/^\d{4}-\d{2}-\d{2}$/.test(a.before) || !a.out) fail('--before YYYY-MM-DD dan --out <file.jsonl.gz> wajib diisi');
  const n = await withAdmin(async (c) => {
    const { rows } = await c.query(`SELECT * FROM audit_logs WHERE created_at < $1::date ORDER BY id`, [a.before]);
    if (rows.length === 0) return 0;
    await pipeline(Readable.from(rows.map((r) => `${JSON.stringify(r)}\n`)), createGzip(), createWriteStream(a.out!, { mode: 0o600, flags: 'wx' }));
    await c.query(`SELECT set_config('rtka.allow_audit_purge', 'on', true)`);
    const del = await c.query(`DELETE FROM audit_logs WHERE created_at < $1::date AND id <= $2`, [a.before, rows[rows.length - 1].id]);
    await cliAudit(c, null, 'platform.audit_diarsipkan', 'audit_logs', a.before!, { jumlah: del.rowCount, berkas: a.out });
    return del.rowCount ?? 0;
  });
  console.log(n ? `${n} baris audit sebelum ${a.before} diarsipkan ke ${a.out} lalu dihapus dari database.` : 'Tidak ada baris yang perlu diarsipkan.');
};

const [command, ...rest] = process.argv.slice(2);
const handler = command ? commands[command] : undefined;
if (!handler) fail(`Perintah tersedia: ${Object.keys(commands).join(', ')}`);
const { values } = parseArgs({
  args: rest,
  options: Object.fromEntries(
    ['name', 'timezone', 'patient-prefix', 'receipt-prefix', 'org', 'email', 'status', 'before', 'out'].map((k) => [k, { type: 'string' as const }]),
  ),
  strict: true,
});
handler(values as Record<string, string | undefined>).catch((err) => fail((err as Error).message));
