import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTenant, json, login, multipartBody, ORIGIN, setupEnv, type Agent, type Tenant, type TestEnv } from './helpers.ts';

let env: TestEnv;
let A: Tenant;
let B: Tenant;
let owner: Agent;

const PDF = Buffer.from('%PDF-1.4\n% DEMO dokumen uji\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

function upload(agent: Agent, patientId: string, fields: Record<string, string>, file: { name: string; content: Buffer; type?: string }) {
  const body = multipartBody(fields, file);
  return env.app.inject({
    method: 'POST',
    url: `/api/patients/${patientId}/documents`,
    payload: body.payload,
    headers: { cookie: agent.cookie, 'x-csrf-token': agent.csrf, origin: ORIGIN, 'content-type': body.contentType },
  });
}

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  B = await buildTenant(env.adminPool, 'B');
  owner = await login(env.app, A.owner.email);
});
afterAll(() => env.close());

describe('Berkas pasien', () => {
  it('unggah PDF berhasil; unduh hanya melalui endpoint terotorisasi', async () => {
    const res = await upload(owner, A.patientId, { title: 'DEMO Surat rujukan', category: 'administrasi' }, { name: 'rujukan.pdf', content: PDF, type: 'application/pdf' });
    expect(res.statusCode, res.body).toBe(201);
    const id = json(res).id;
    const dl = await owner.get(`/api/documents/${id}/download`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(dl.rawPayload.equals(PDF)).toBe(true);

    // Tanpa sesi -> 401; organisasi lain -> 404.
    expect((await env.app.inject({ method: 'GET', url: `/api/documents/${id}/download` })).statusCode).toBe(401);
    const ownerB = await login(env.app, B.owner.email);
    expect((await ownerB.get(`/api/documents/${id}/download`)).statusCode).toBe(404);
    // Berkas tidak tersedia sebagai file statis publik: path penyimpanan aslinya tidak mengembalikan isi berkas
    // (yang ada hanya halaman aplikasi/404).
    const { rows } = await env.adminPool.query(`SELECT storage_key FROM patient_documents WHERE id = $1`, [id]);
    for (const url of [`/${rows[0].storage_key}`, `/uploads/${rows[0].storage_key}`, `/api/${rows[0].storage_key}`]) {
      const res = await env.app.inject({ method: 'GET', url });
      expect(res.rawPayload.includes(Buffer.from('%PDF')), url).toBe(false);
    }
  });

  it('jenis berkas diverifikasi dari isi, bukan dari nama/Content-Type', async () => {
    const fake = await upload(owner, A.patientId, { title: 'DEMO Palsu', category: 'administrasi' }, {
      name: 'dokumen.pdf',
      content: Buffer.from('<script>alert(1)</script>'),
      type: 'application/pdf',
    });
    expect(fake.statusCode).toBe(400);
    const png = await upload(owner, A.patientId, { title: 'DEMO Foto', category: 'administrasi' }, { name: 'foto.exe', content: PNG });
    expect(png.statusCode).toBe(201);
    const list = json<any[]>(await owner.get(`/api/patients/${A.patientId}/documents`));
    expect(list.find((d) => d.id === json(png).id).mimeType).toBe('image/png');
  });

  it('berkas melebihi batas ukuran ditolak', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(1024 * 1024 + 10)]);
    const res = await upload(owner, A.patientId, { title: 'DEMO Besar', category: 'administrasi' }, { name: 'besar.pdf', content: big });
    expect(res.statusCode).toBe(413);
  });

  it('dokumen klinis tidak dapat dilihat/diunggah oleh peran tanpa akses klinis', async () => {
    const clinical = json(await upload(owner, A.patientId, { title: 'DEMO Hasil asesmen', category: 'klinis' }, { name: 'asesmen.pdf', content: PDF }));
    const finance = await login(env.app, A.finance.email);
    const list = json<any[]>(await finance.get(`/api/patients/${A.patientId}/documents`));
    expect(list.some((d) => d.id === clinical.id)).toBe(false);
    expect((await finance.get(`/api/documents/${clinical.id}/download`)).statusCode).toBe(404);
    const admin = await login(env.app, A.admin.email);
    const up = await upload(admin, A.patientId, { title: 'DEMO Klinis', category: 'klinis' }, { name: 'x.pdf', content: PDF });
    expect(up.statusCode).toBe(403);
  });

  it.skipIf(!existsSync(path.resolve(import.meta.dirname, '../../web/dist/index.html')))(
    'aset web yang tidak ada dijawab 404 (bukan halaman HTML); rute halaman mendapat aplikasi web',
    async () => {
      const missing = await env.app.inject({ method: 'GET', url: '/assets/tidak-ada-123.js' });
      expect(missing.statusCode).toBe(404);
      expect(String(missing.headers['content-type'])).not.toContain('text/html');
      const page = await env.app.inject({ method: 'GET', url: '/pasien/123' });
      expect(page.statusCode).toBe(200);
      expect(String(page.headers['content-type'])).toContain('text/html');
    },
  );

  it('terapis tidak dapat mengunggah ke pasien yang tidak ditugaskan', async () => {
    const t = await login(env.app, A.therapist.email);
    const res = await upload(t, A.patient2Id, { title: 'DEMO', category: 'klinis' }, { name: 'x.pdf', content: PDF });
    expect(res.statusCode).toBe(404);
  });
});
