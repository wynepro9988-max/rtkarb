import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../src/db.ts';
import { buildTenant, json, localDate, login, ORIGIN, setupEnv, type Agent, type Tenant, type TestEnv } from './helpers.ts';

// Pendaftaran online (pengganti Google Form). Semua data uji adalah data DEMO.
let env: TestEnv;
let A: Tenant;
let B: Tenant;
let owner: Agent;
let admin: Agent;
let token: string;

const publicGet = (t: string) => env.app.inject({ method: 'GET', url: `/api/public/registration/${t}` });
const publicPost = (t: string, payload: object, origin = ORIGIN) =>
  env.app.inject({ method: 'POST', url: `/api/public/registration/${t}`, payload, headers: { origin } });

const form = (over: object = {}) => ({
  childName: 'DEMO Anak Daring',
  birthPlace: 'Surakarta',
  birthDate: '2021-03-31',
  guardianName: 'DEMO Ibu Daring',
  relationship: 'Ibu',
  phone: '0812-0000-5001',
  address: 'DEMO Perum Contoh RT 01 RW 02',
  complaint: 'DEMO kurang fokus dan bicara belum jelas',
  assessmentDate: localDate(2),
  assessmentTime: '16:00',
  agree: true,
  ...over,
});

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  B = await buildTenant(env.adminPool, 'B');
  owner = await login(env.app, A.owner.email);
  admin = await login(env.app, A.admin.email);
});
afterAll(() => env.close());

describe('Pendaftaran online', () => {
  it('owner membuka pendaftaran; admin hanya dapat menyalin tautan', async () => {
    expect(json(await admin.get('/api/org/registration-link'))).toEqual({ open: false, token: null });
    expect((await admin.put('/api/org/registration-link', { open: true })).statusCode).toBe(403);
    const r = json(await owner.put('/api/org/registration-link', { open: true }));
    expect(r.open).toBe(true);
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
    token = r.token;
    expect(json(await admin.get('/api/org/registration-link')).token).toBe(token);
  });

  it('orang tua mengisi formulir publik tanpa akun', async () => {
    const info = json(await publicGet(token));
    expect(info.organizationName).toContain('DEMO Organisasi A');
    expect(Object.keys(info).sort()).toEqual(['organizationName', 'today']);
    expect((await publicPost(token, form())).statusCode).toBe(201);
    expect((await publicPost(token, form({ childName: 'DEMO Anak Kedua', relationship: 'Ayah', phone: '085600005002' }))).statusCode).toBe(201);
  });

  it('validasi: persetujuan, nomor WA, tanggal, tautan salah, asal permintaan lain; kiriman bot tidak disimpan', async () => {
    expect((await publicPost(token, form({ agree: false }))).statusCode).toBe(400);
    expect((await publicPost(token, form({ phone: '12345' }))).statusCode).toBe(400);
    expect((await publicPost(token, form({ birthDate: localDate(3) }))).statusCode).toBe(400);
    expect((await publicPost(token, form({ assessmentDate: localDate(-1) }))).statusCode).toBe(400);
    expect((await publicPost(token, form({ assessmentDate: localDate(400) }))).statusCode).toBe(400);
    expect((await publicPost('x'.repeat(30), form())).statusCode).toBe(404);
    expect((await publicGet('x'.repeat(30))).statusCode).toBe(404);
    expect((await publicPost(token, form(), 'https://situs-lain.example')).statusCode).toBe(403);
    expect((await publicPost(token, form({ childName: 'DEMO Bot', website: 'http://spam.example' }))).statusCode).toBe(201);
    const { rows } = await env.adminPool.query(`SELECT count(*)::int AS n FROM registration_requests WHERE organization_id = $1`, [A.orgId]);
    expect(rows[0].n).toBe(2);
  });

  it('hanya owner dan admin yang melihat pendaftaran masuk; terapis, keuangan, dan organisasi lain tidak', async () => {
    const list = json(await admin.get('/api/registrations'));
    expect(list.map((r: any) => r.childName)).toEqual(['DEMO Anak Daring', 'DEMO Anak Kedua']);
    expect(list[0]).toMatchObject({ phone: '6281200005001', guardianRelationship: 'Ibu', assessmentTime: '16:00', existingPatientCode: null });
    for (const who of [A.therapist.email, A.finance.email]) {
      expect((await (await login(env.app, who)).get('/api/registrations')).statusCode).toBe(403);
    }
    expect(json(await (await login(env.app, B.owner.email)).get('/api/registrations'))).toEqual([]);
    expect(json(await admin.get('/api/dashboard')).registrationsPending).toBe(2);
  });

  it('diterima: menjadi pasien dengan No. RM, data pemeriksaan, dan tidak dapat diproses dua kali', async () => {
    const [first, second] = json(await admin.get('/api/registrations'));
    const body = {
      fullName: first.childName,
      birthPlace: first.birthPlace,
      birthDate: first.birthDate,
      address: first.address,
      guardians: [{ fullName: first.guardianName, relationship: 'Ibu', phone: '081200005001', isPrimary: true }],
      intake: { complaint: first.complaint },
      registrationRequestId: first.id,
    };
    const res = await admin.post('/api/patients', body);
    expect(res.statusCode).toBe(201);
    const p = json(res);
    expect((await admin.post('/api/patients', body)).statusCode).toBe(409);
    const accepted = json(await admin.get('/api/registrations?status=diterima'));
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ patientId: p.id, patientCode: p.patientCode });

    expect((await admin.post(`/api/registrations/${second.id}/reject`, { reason: 'DEMO pendaftaran ganda' })).statusCode).toBe(200);
    expect((await admin.post(`/api/registrations/${second.id}/reject`, { reason: 'DEMO ulang' })).statusCode).toBe(409);
    expect(json(await admin.get('/api/registrations'))).toEqual([]);

    // Pendaftaran berikutnya dengan nama & tanggal lahir yang sama ditandai kemungkinan ganda.
    await publicPost(token, form());
    expect(json(await admin.get('/api/registrations'))[0].existingPatientCode).toBe(p.patientCode);
  });

  it('RLS: pendaftaran online hanya terbaca dengan cakupan intake all; tidak dapat disisipkan langsung', async () => {
    const run = <T>(settings: Record<string, string>, fn: (db: any) => Promise<T>) =>
      withTx(env.appPool, { settings: { 'app.mode': 'tenant', 'app.org_id': A.orgId, 'app.scope_patient': 'all', 'app.scope_note': 'none', 'app.scope_finance': 'none', 'app.scope_audit': 'none', ...settings } }, fn);
    const count = (scope: string) => run({ 'app.scope_intake': scope }, async (db) => (await db.one(`SELECT count(*)::int AS n FROM registration_requests`)).n);
    expect(await count('all')).toBeGreaterThan(0);
    expect(await count('assigned')).toBe(0);
    expect(await count('none')).toBe(0);
    await expect(
      run({ 'app.scope_intake': 'all' }, (db) =>
        db.exec(
          `INSERT INTO registration_requests (organization_id, child_name, birth_place, birth_date, guardian_name, guardian_relationship, phone, address, complaint, assessment_date, assessment_time)
           VALUES ($1, 'DEMO X', 'Solo', '2020-01-01', 'DEMO Y', 'Ibu', '6281200000000', 'DEMO alamat', 'DEMO', current_date, '10:00')`,
          [A.orgId],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('pendaftaran ditutup atau tautan diganti: tautan lama tidak berlaku', async () => {
    const r = json(await owner.put('/api/org/registration-link', { open: true, regenerate: true }));
    expect(r.token).not.toBe(token);
    expect((await publicGet(token)).statusCode).toBe(404);
    expect((await publicGet(r.token)).statusCode).toBe(200);
    await owner.put('/api/org/registration-link', { open: false });
    expect((await publicGet(r.token)).statusCode).toBe(404);
    expect((await publicPost(r.token, form())).statusCode).toBe(404);
  });
});
