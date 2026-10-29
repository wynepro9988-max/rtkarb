import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { SupabaseFileStore } from '../src/lib/storage.ts';
import { buildTenant, createUser, json, login, multipartBody, ORIGIN, setupEnv, type Agent, type Tenant, type TestEnv } from './helpers.ts';

// Supabase Storage tiruan (in-memory) untuk menguji driver REST tanpa layanan sungguhan.
interface Hit {
  method: string;
  url: string;
  apikey?: string;
  authorization?: string;
}
function fakeStorage() {
  const objects = new Map<string, Buffer>();
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    hits.push({ method: req.method!, url: req.url!, apikey: req.headers.apikey as string, authorization: req.headers.authorization });
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const m = req.url!.match(/^\/storage\/v1\/object\/(authenticated\/)?([^/]+)\/(.+)$/);
      if (!m || !req.headers.apikey) return res.writeHead(401).end();
      const key = `${m[2]}/${m[3]}`;
      if (req.method === 'POST') {
        if (objects.has(key)) return res.writeHead(400).end('{"error":"Duplicate"}');
        objects.set(key, Buffer.concat(chunks));
        return res.writeHead(200).end('{}');
      }
      if (req.method === 'GET') return objects.has(key) ? res.writeHead(200).end(objects.get(key)) : res.writeHead(404).end();
      if (req.method === 'DELETE') {
        objects.delete(key);
        return res.writeHead(200).end('{}');
      }
      res.writeHead(405).end();
    });
  });
  return { server, objects, hits };
}

const PDF = Buffer.from('%PDF-1.4\n% DEMO dokumen uji supabase\n%%EOF\n');

let env: TestEnv;
let A: Tenant;
let storage: ReturnType<typeof fakeStorage>;
let storageUrl: string;

function upload(app: import('fastify').FastifyInstance, agent: Agent, patientId: string, content = PDF) {
  const body = multipartBody({ title: 'DEMO Surat', category: 'administrasi' }, { name: 'surat.pdf', content });
  return app.inject({
    method: 'POST',
    url: `/api/patients/${patientId}/documents`,
    payload: body.payload,
    headers: { cookie: agent.cookie, 'x-csrf-token': agent.csrf, origin: ORIGIN, 'content-type': body.contentType },
  });
}

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  storage = fakeStorage();
  await new Promise<void>((r) => storage.server.listen(0, '127.0.0.1', r));
  storageUrl = `http://127.0.0.1:${(storage.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  storage.server.close();
  await env.close();
});

describe('Pengamanan database untuk Supabase (migrasi 004)', () => {
  it('role Data API (anon/authenticated) tidak memiliki hak apa pun atas tabel & fungsi aplikasi', async () => {
    const { rows: roles } = await env.adminPool.query(`SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`);
    expect(roles.length, 'role simulasi Supabase belum dibuat (lihat scripts/db-local.sh)').toBe(2);
    const { rows } = await env.adminPool.query(
      `SELECT r.rolname, c.relname
         FROM pg_class c CROSS JOIN (VALUES ('anon'), ('authenticated')) r(rolname)
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
          AND has_table_privilege(r.rolname, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')`,
    );
    expect(rows).toEqual([]);
    const { rows: fns } = await env.adminPool.query(
      `SELECT r.rolname, p.proname
         FROM pg_proc p CROSS JOIN (VALUES ('anon'), ('authenticated')) r(rolname)
        WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')`,
    );
    expect(fns).toEqual([]);
  });

  it('semua tabel aplikasi memakai Row-Level Security (termasuk sessions)', async () => {
    const { rows } = await env.adminPool.query(
      `SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND NOT relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it('audit log hanya dapat diarsipkan oleh pemilik skema dengan flag eksplisit; tabel append-only lain tetap terkunci', async () => {
    const c = await env.adminPool.connect();
    try {
      await c.query(`INSERT INTO audit_logs (organization_id, action) VALUES ($1, 'uji.arsip')`, [A.orgId]);
      // Baris ledger nyata agar trigger per-baris benar-benar diuji (DELETE pada tabel kosong tidak memicu trigger).
      const pkg = await c.query<{ id: string }>(
        `INSERT INTO patient_packages (organization_id, patient_id, name, sessions_total, price, purchased_on)
         VALUES ($1, $2, 'DEMO Paket Uji Arsip', 2, 0, current_date) RETURNING id`,
        [A.orgId, A.patientId],
      );
      await c.query(
        `INSERT INTO package_ledger (organization_id, patient_id, patient_package_id, kind, sessions_delta, sessions_used_after)
         VALUES ($1, $2, $3, 'penyesuaian', 1, 1)`,
        [A.orgId, A.patientId, pkg.rows[0].id],
      );
      await c.query('BEGIN');
      await c.query(`SELECT set_config('rtka.allow_audit_purge', 'on', true), set_config('rtka.allow_erasure', 'on', true)`);
      const del = await c.query(`DELETE FROM audit_logs WHERE action = 'uji.arsip'`);
      expect(del.rowCount).toBe(1);
      await expect(c.query(`DELETE FROM package_ledger WHERE patient_package_id = $1`, [pkg.rows[0].id])).rejects.toThrow(/append-only/);
      await c.query('ROLLBACK');
      // Tanpa flag tetap ditolak.
      await expect(c.query(`DELETE FROM audit_logs WHERE action = 'uji.arsip'`)).rejects.toThrow(/append-only/);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  });
});

describe('Supabase Storage (driver REST) & kuota', () => {
  it('unggah dan unduh lewat Supabase Storage; kunci rahasia hanya di header apikey', async () => {
    const app = await buildApp(env.config, env.appPool, { fileStore: new SupabaseFileStore(storageUrl, 'sb_secret_uji', 'dokumen-pasien') });
    const owner = await login(app, A.owner.email);
    const up = await upload(app, owner, A.patientId);
    expect(up.statusCode, up.body).toBe(201);
    const dl = await owner.get(`/api/documents/${json(up).id}/download`);
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(PDF)).toBe(true);

    const post = storage.hits.find((h) => h.method === 'POST')!;
    expect(post.url).toMatch(new RegExp(`^/storage/v1/object/dokumen-pasien/${A.orgId}/[0-9a-f-]{36}\\.pdf$`));
    expect(post.apikey).toBe('sb_secret_uji');
    expect(post.authorization).toBeUndefined();
    expect(storage.hits.find((h) => h.method === 'GET')!.url).toContain('/storage/v1/object/authenticated/dokumen-pasien/');
    await app.close();
  });

  it('kunci JWT lama (service_role) dikirim juga sebagai Bearer', async () => {
    const store = new SupabaseFileStore(storageUrl, 'eyJ.uji.jwt', 'dokumen-pasien');
    expect(store.headers).toEqual({ apikey: 'eyJ.uji.jwt', Authorization: 'Bearer eyJ.uji.jwt' });
  });

  it('kuota penyimpanan organisasi ditegakkan dan unggahan yang ditolak tidak meninggalkan berkas yatim', async () => {
    const app = await buildApp({ ...env.config, orgStorageQuotaBytes: PDF.length * 2 + 10 }, env.appPool, {
      fileStore: new SupabaseFileStore(storageUrl, 'sb_secret_uji', 'dokumen-pasien'),
    });
    const owner = await login(app, A.owner.email);
    const usage = json(await owner.get('/api/org/storage'));
    expect(usage.quotaBytes).toBe(PDF.length * 2 + 10);
    // Unggahan pertama tes sebelumnya sudah memakai 1x; satu lagi masih muat, berikutnya ditolak.
    expect((await upload(app, owner, A.patientId)).statusCode).toBe(201);
    const before = storage.objects.size;
    const rejected = await upload(app, owner, A.patientId);
    expect(rejected.statusCode).toBe(413);
    expect(json(rejected).error.code).toBe('quota_exceeded');
    expect(storage.objects.size).toBe(before);
    await app.close();
  });
});

describe('Pemantauan kapasitas', () => {
  it('admin teknis melihat angka kapasitas (tanpa data pasien); owner tidak bisa', async () => {
    const p = await createUser(env.adminPool, 'platformusage', true);
    const platform = await login(env.app, p.email);
    const res = await platform.get('/api/platform/usage');
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.database.limitBytes).toBe(500 * 1024 * 1024);
    expect(body.database.usedBytes).toBeGreaterThan(0);
    const org = body.organizations.find((o: any) => o.orgId === A.orgId);
    expect(Object.keys(org).sort()).toEqual(['auditRows', 'noteCount', 'orgId', 'orgName', 'patientCount', 'storageBytes']);
    expect(res.body).not.toContain('DEMO Anak');
    const owner = await login(env.app, A.owner.email);
    expect((await owner.get('/api/platform/usage')).statusCode).toBe(403);
  });

  it('health check dengan ?db=1 memeriksa koneksi database', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/health?db=1' });
    expect(res.statusCode).toBe(200);
  });
});
