import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../src/db.ts';
import { sha256Hex } from '../src/security/tokens.ts';
import { buildTenant, json, login, ORIGIN, PASSWORD, setupEnv, testPhone, testUsername, type Agent, type Tenant, type TestEnv } from './helpers.ts';

// Username, undangan WhatsApp, dan dasbor orang tua. Semua data sintetis (DEMO).
let env: TestEnv;
let A: Tenant;
let B: Tenant;
let admin: Agent;

const NEW_PASSWORD = 'SandiWaliAman#2026';
const tokenFrom = (url: string) => url.split('#token=')[1];
const post = (url: string, payload: unknown) => env.app.inject({ method: 'POST', url, payload: payload as object, headers: { origin: ORIGIN } });

async function addGuardian(agent: Agent, patientId: string, phone: string | null = testPhone()) {
  const res = await agent.post(`/api/patients/${patientId}/guardians`, { fullName: 'DEMO Ibu Wali', relationship: 'Ibu', phone });
  expect(res.statusCode).toBe(201);
  return json(res).id as string;
}

async function activateGuardian(agent: Agent, guardianId: string) {
  const invite = await agent.post(`/api/guardians/${guardianId}/invite`);
  expect(invite.statusCode).toBe(200);
  const body = json(invite);
  expect(body.url).toContain('#token=');
  const username = testUsername('wali');
  const accept = await post('/api/auth/accept-invitation', { token: tokenFrom(body.url), username, password: NEW_PASSWORD });
  expect(accept.statusCode).toBe(200);
  return { username, phone: body.phone as string, agent: await login(env.app, username, NEW_PASSWORD) };
}

async function session(t: Tenant, patientId: string, dayOffset: number, status = 'terjadwal') {
  const { rows } = await env.adminPool.query<{ id: string }>(
    `INSERT INTO appointments (organization_id, patient_id, therapist_member_id, service_id, starts_at, duration_minutes, status, billing, price, admin_notes, completed_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5), 60, $6, 'per_sesi', 150000, 'DEMO catatan internal', CASE WHEN $6 = 'selesai' THEN now() END) RETURNING id`,
    [t.orgId, patientId, t.therapist.memberId, t.serviceId, dayOffset, status],
  );
  return rows[0].id;
}

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  B = await buildTenant(env.adminPool, 'B');
  admin = await login(env.app, A.admin.email);
});
afterAll(() => env.close());

describe('Login username', () => {
  it('staf diundang lewat nomor WhatsApp tanpa email, memilih username, lalu masuk dengan username huruf besar-kecil apa pun', async () => {
    const owner = await login(env.app, A.owner.email);
    const phone = testPhone();
    const inv = await owner.post('/api/staff/invitations', { phone, fullName: 'DEMO Terapis WA', role: 'terapis' });
    expect(inv.statusCode).toBe(201);
    expect(json(inv).phone).toBe(`62${phone.slice(1)}`);

    const info = json(await post('/api/auth/token-info', { token: tokenFrom(json(inv).url) }));
    expect(info).toMatchObject({ purpose: 'undangan', account: null, role: 'terapis' });

    const username = testUsername('terapis');
    const token = tokenFrom(json(inv).url);
    expect((await post('/api/auth/accept-invitation', { token, username: 'a b', password: NEW_PASSWORD })).statusCode).toBe(400);
    expect((await post('/api/auth/accept-invitation', { token, username, password: `${username}-rahasia` })).statusCode).toBe(400);
    expect((await post('/api/auth/accept-invitation', { token, username, password: NEW_PASSWORD })).statusCode).toBe(200);

    const { rows } = await env.adminPool.query(`SELECT email, phone FROM users WHERE username = $1`, [username]);
    expect(rows).toEqual([{ email: null, phone: `62${phone.slice(1)}` }]);

    const staff = await login(env.app, username.toUpperCase(), NEW_PASSWORD);
    expect(json(await staff.get('/api/auth/me')).user).toMatchObject({ username, email: null });
    expect(json(await owner.get('/api/staff')).find((m: any) => m.username === username).phone).toBe(`62${phone.slice(1)}`);
  });

  it('nomor WhatsApp tidak valid ditolak dan undangan ulang ke nomor yang sama membatalkan yang lama', async () => {
    const owner = await login(env.app, A.owner.email);
    expect((await owner.post('/api/staff/invitations', { phone: '12345678', fullName: 'DEMO Salah', role: 'admin' })).statusCode).toBe(400);
    const phone = testPhone();
    const first = json(await owner.post('/api/staff/invitations', { phone, fullName: 'DEMO Ulang', role: 'admin' }));
    const second = json(await owner.post('/api/staff/invitations', { phone, fullName: 'DEMO Ulang', role: 'admin' }));
    expect((await post('/api/auth/accept-invitation', { token: tokenFrom(first.url), username: testUsername('ulang'), password: NEW_PASSWORD })).statusCode).toBe(400);
    expect((await post('/api/auth/accept-invitation', { token: tokenFrom(second.url), username: testUsername('ulang'), password: NEW_PASSWORD })).statusCode).toBe(200);
  });

  it('username bersifat unik lintas organisasi, dan akun email lama tetap bisa masuk lalu mengatur username', async () => {
    const owner = await login(env.app, B.owner.email);
    const username = testUsername('kembar');
    const first = json(await (await login(env.app, A.owner.email)).post('/api/staff/invitations', { phone: testPhone(), fullName: 'DEMO Satu', role: 'admin' }));
    expect((await post('/api/auth/accept-invitation', { token: tokenFrom(first.url), username, password: NEW_PASSWORD })).statusCode).toBe(200);
    const second = json(await owner.post('/api/staff/invitations', { phone: testPhone(), fullName: 'DEMO Dua', role: 'admin' }));
    expect((await post('/api/auth/accept-invitation', { token: tokenFrom(second.url), username, password: NEW_PASSWORD })).statusCode).toBe(409);

    expect((await owner.post('/api/auth/username', { username, currentPassword: PASSWORD })).statusCode).toBe(409);
    const mine = testUsername('ownerb');
    expect((await owner.post('/api/auth/username', { username: mine, currentPassword: 'salah-sandi' })).statusCode).toBe(400);
    expect((await owner.post('/api/auth/username', { username: mine, currentPassword: PASSWORD })).statusCode).toBe(200);
    await login(env.app, mine);
    await login(env.app, B.owner.email);
  });

  it('reset kata sandi tetap berjalan untuk akun tanpa email dan mengembalikan nomor WhatsApp', async () => {
    const owner = await login(env.app, A.owner.email);
    const phone = testPhone();
    const inv = json(await owner.post('/api/staff/invitations', { phone, fullName: 'DEMO Lupa Sandi', role: 'admin' }));
    const username = testUsername('lupa');
    await post('/api/auth/accept-invitation', { token: tokenFrom(inv.url), username, password: NEW_PASSWORD });
    const staff = json(await owner.get('/api/staff')).find((m: any) => m.username === username);
    const reset = json(await owner.post(`/api/staff/${staff.id}/reset-link`));
    expect(reset.phone).toBe(`62${phone.slice(1)}`);
    expect(json(await post('/api/auth/token-info', { token: tokenFrom(reset.url) })).account).toBe(username);
    expect((await post('/api/auth/reset-password', { token: tokenFrom(reset.url), password: 'SandiResetBaru#10' })).statusCode).toBe(200);
    await login(env.app, username, 'SandiResetBaru#10');
  });
});

describe('Undangan orang tua', () => {
  it('admin dan owner dapat mengundang; terapis dan keuangan tidak; wali tanpa nomor ditolak; organisasi lain tidak dapat', async () => {
    const guardianId = await addGuardian(admin, A.patientId);
    for (const staff of [A.therapist, A.finance]) {
      expect((await (await login(env.app, staff.email)).post(`/api/guardians/${guardianId}/invite`)).statusCode).toBe(403);
    }
    expect((await (await login(env.app, B.admin.email)).post(`/api/guardians/${guardianId}/invite`)).statusCode).toBe(404);
    const noPhone = await addGuardian(admin, A.patientId, null);
    expect((await admin.post(`/api/guardians/${noPhone}/invite`)).statusCode).toBe(400);
  });

  it('aktivasi menghubungkan akun ke anak; akun wali tidak muncul sebagai staf', async () => {
    const guardianId = await addGuardian(admin, A.patientId);
    const pending = json(await admin.get(`/api/patients/${A.patientId}`)).guardians.find((g: any) => g.id === guardianId);
    expect(pending).toMatchObject({ memberId: null, accountUsername: null, inviteExpiresAt: null });

    const invite = json(await admin.post(`/api/guardians/${guardianId}/invite`));
    expect(json(await admin.get(`/api/patients/${A.patientId}`)).guardians.find((g: any) => g.id === guardianId).inviteExpiresAt).not.toBeNull();
    const username = testUsername('wali');
    expect((await post('/api/auth/accept-invitation', { token: tokenFrom(invite.url), username, password: NEW_PASSWORD })).statusCode).toBe(200);

    const linked = json(await admin.get(`/api/patients/${A.patientId}`)).guardians.find((g: any) => g.id === guardianId);
    expect(linked.accountUsername).toBe(username);
    expect((await admin.post(`/api/guardians/${guardianId}/invite`)).statusCode).toBe(409);

    const owner = await login(env.app, A.owner.email);
    expect(json(await owner.get('/api/staff')).some((m: any) => m.username === username)).toBe(false);
    expect(json(await owner.get('/api/staff/invitations')).some((i: any) => i.role === 'wali')).toBe(false);
    const wali = await login(env.app, username, NEW_PASSWORD);
    expect(json(await wali.get('/api/auth/me'))).toMatchObject({ mode: 'portal', permissions: ['portal.view'] });
  });

  it('kakak-adik: undangan kedua dengan nomor sama langsung terhubung ke akun yang sama', async () => {
    const phone = testPhone();
    const first = await addGuardian(admin, A.patientId, phone);
    const second = await addGuardian(admin, A.patient2Id, phone);
    const { agent } = await activateGuardian(admin, first);
    expect(json(await agent.get('/api/portal')).children).toHaveLength(1);
    expect(json(await admin.post(`/api/guardians/${second}/invite`))).toEqual({ linked: true });
    expect(json(await agent.get('/api/portal')).children.map((c: any) => c.id).sort()).toEqual([A.patientId, A.patient2Id].sort());
  });

  it('mencabut akses anak terakhir menutup akun dan sesinya seketika; undangan ulang mengaktifkan kembali', async () => {
    const phone = testPhone();
    const guardianId = await addGuardian(admin, A.patient2Id, phone);
    const { agent, username } = await activateGuardian(admin, guardianId);
    expect((await admin.post(`/api/guardians/${guardianId}/revoke-access`)).statusCode).toBe(200);
    expect((await agent.get('/api/portal')).statusCode).toBe(401);
    expect((await post('/api/auth/login', { identifier: username, password: NEW_PASSWORD })).statusCode).toBe(401);

    expect(json(await admin.post(`/api/guardians/${guardianId}/invite`))).toEqual({ linked: true });
    await login(env.app, username, NEW_PASSWORD);
  });

  it('undangan yang dicabut, dan undangan milik wali yang dihapus, tidak dapat dipakai', async () => {
    const revoked = await addGuardian(admin, A.patient2Id);
    const a = json(await admin.post(`/api/guardians/${revoked}/invite`));
    await admin.post(`/api/guardians/${revoked}/revoke-access`);
    expect((await post('/api/auth/accept-invitation', { token: tokenFrom(a.url), username: testUsername('cabut'), password: NEW_PASSWORD })).statusCode).toBe(400);

    const deleted = await addGuardian(admin, A.patient2Id);
    const b = json(await admin.post(`/api/guardians/${deleted}/invite`));
    expect((await admin.delete(`/api/guardians/${deleted}`)).statusCode).toBe(200);
    expect((await post('/api/auth/accept-invitation', { token: tokenFrom(b.url), username: testUsername('hapus'), password: NEW_PASSWORD })).statusCode).toBe(400);
  });

  it('admin membuat tautan reset untuk wali', async () => {
    const guardianId = await addGuardian(admin, A.patient2Id);
    const { username } = await activateGuardian(admin, guardianId);
    const reset = json(await admin.post(`/api/guardians/${guardianId}/reset-link`));
    expect((await post('/api/auth/reset-password', { token: tokenFrom(reset.url), password: 'SandiWaliBaru#2027' })).statusCode).toBe(200);
    await login(env.app, username, 'SandiWaliBaru#2027');
  });
});

describe('Dasbor orang tua', () => {
  it('hanya menampilkan anak sendiri: jadwal, kehadiran, paket, dan tagihan dengan angka yang sama seperti staf', async () => {
    const guardianId = await addGuardian(admin, A.patientId);
    const { agent } = await activateGuardian(admin, guardianId);
    const mine = await session(A, A.patientId, 2);
    const done = await session(A, A.patientId, 0, 'selesai');
    const missed = await session(A, A.patientId, -2, 'tidak_hadir');
    const other = await session(A, A.patient2Id, 2);
    const otherOrg = await session(B, B.patientId, 2);

    const owner = await login(env.app, A.owner.email);
    const pkg = json(await owner.post(`/api/patients/${A.patientId}/packages`, { packageTypeId: A.packageTypeId }));
    const invoice = json(await owner.post('/api/invoices', { patientId: A.patientId, items: [{ kind: 'lainnya', description: 'DEMO Asesmen', unitPrice: 300000 }] }));
    const pay = await owner.post('/api/payments', { patientId: A.patientId, invoiceId: invoice.id, amount: 100000, method: 'tunai', paidOn: new Date().toISOString().slice(0, 10) });
    expect(pay.statusCode).toBe(201);

    const res = await agent.get('/api/portal');
    expect(res.statusCode).toBe(200);
    const p = json(res);
    expect(p.children.map((c: any) => c.id)).toEqual([A.patientId]);

    const ids = [...p.upcoming, ...p.history].map((s: any) => s.id);
    expect(ids).toEqual(expect.arrayContaining([mine, done, missed]));
    expect(ids).not.toContain(other);
    expect(ids).not.toContain(otherOrg);
    expect(p.upcoming.find((s: any) => s.id === mine)).toMatchObject({ serviceName: 'Terapi Wicara', status: 'terjadwal' });
    expect(p.upcoming.every((s: any) => s.patientId === A.patientId)).toBe(true);

    const invoiceRow = p.invoices.find((i: any) => i.id === invoice.id);
    expect(invoiceRow).toMatchObject({ total: 300000, paid: 100000 });
    expect(p.packages.find((x: any) => x.id === pkg.id)).toMatchObject({ sessionsTotal: 8, sessionsUsed: 0 });
    expect(p.attendance.find((a: any) => a.patientId === A.patientId).attended).toBeGreaterThanOrEqual(1);

    // Tidak ada catatan internal maupun harga sesi di respons.
    expect(res.body).not.toContain('DEMO catatan internal');
    expect(res.body).not.toContain('adminNotes');
    expect(res.body).not.toContain('"price"');
  });

  it('akun tanpa anak terhubung tidak melihat apa pun dan staf tidak dapat membuka dasbor orang tua', async () => {
    const staff = await login(env.app, A.owner.email);
    expect((await staff.get('/api/portal')).statusCode).toBe(403);
    expect((await staff.get(`/api/portal/notes?patientId=${A.patientId}`)).statusCode).toBe(403);
  });

  it('orang tua membaca catatan final anaknya versi terbaru; draf dan anak lain tertutup; pembacaan tercatat di audit', async () => {
    const guardianId = await addGuardian(admin, A.patientId);
    const { agent } = await activateGuardian(admin, guardianId);
    const url = `/api/portal/notes?patientId=${A.patientId}`;
    const therapist = await login(env.app, A.therapist.email);
    const write = (observations: string, finalize: boolean) =>
      therapist.post('/api/notes', { patientId: A.patientId, noteType: 'sesi', observations, homeProgram: 'DEMO latihan di rumah', finalize });

    const final = json(await write('DEMO catatan final', true));
    expect((await write('DEMO catatan draf', false)).statusCode).toBe(201);

    const res = await agent.get(url);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('DEMO catatan draf');
    expect(json(res).find((n: any) => n.id === final.id)).toMatchObject({ noteType: 'sesi', observations: 'DEMO catatan final', homeProgram: 'DEMO latihan di rumah' });
    expect(json(res)[0].authorName).toBeTruthy();

    const fix = await therapist.put(`/api/notes/${final.id}`, { observations: 'DEMO catatan dikoreksi', reason: 'Koreksi penulisan' });
    expect(fix.statusCode).toBe(200);
    const after = await agent.get(url);
    expect(after.body).toContain('DEMO catatan dikoreksi');
    expect(after.body).not.toContain('DEMO catatan final');

    expect((await agent.get(`/api/portal/notes?patientId=${A.patient2Id}`)).statusCode).toBe(404);
    expect((await agent.get(`/api/portal/notes?patientId=${B.patientId}`)).statusCode).toBe(404);

    const { rows } = await env.adminPool.query(
      `SELECT actor_member_id, meta FROM audit_logs WHERE organization_id = $1 AND action = 'catatan.dilihat_wali' AND entity_id = $2`,
      [A.orgId, A.patientId],
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].actor_member_id).toBeTruthy();
  });

  it('anonimisasi pasien memutus akses orang tua seketika', async () => {
    const owner = await login(env.app, A.owner.email);
    const patient = json(await owner.post('/api/patients', { fullName: 'DEMO Anak Anonim' }));
    const guardianId = await addGuardian(owner, patient.id);
    const { agent } = await activateGuardian(owner, guardianId);
    expect(json(await agent.get('/api/portal')).children).toHaveLength(1);
    await withTx(
      env.appPool,
      { settings: { 'app.mode': 'tenant', 'app.org_id': A.orgId, 'app.scope_audit': 'all', 'app.scope_patient': 'all' } },
      (db) => db.exec(`SELECT anonymize_patient($1, 'identitas')`, [patient.id]),
    );
    expect(json(await agent.get('/api/portal')).children).toEqual([]);
  });

  it('akun wali ditolak di SETIAP rute staf, termasuk rute yang dibuat di masa depan', async () => {
    const guardianId = await addGuardian(admin, A.patient2Id);
    const { agent } = await activateGuardian(admin, guardianId);
    const id = A.patientId;
    const dir = path.resolve(import.meta.dirname, '../src/routes');
    const routes = new Set<string>();
    for (const file of readdirSync(dir)) {
      if (file === 'portal.ts' || file === 'auth.ts') continue;
      const source = readFileSync(path.join(dir, file), 'utf8');
      for (const m of source.matchAll(/app\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)) routes.add(`${m[1]} ${m[2]}`);
    }
    expect(routes.size).toBeGreaterThan(60);
    const open = [];
    for (const route of routes) {
      const [method, url] = route.split(' ');
      const target = `/api${url.replace(/:[a-zA-Z]+/g, id)}`;
      const res = await agent.request(method.toUpperCase() as 'GET', target, method === 'get' || method === 'delete' ? undefined : {});
      if (res.statusCode < 400 && route !== 'get /health') open.push(`${route} -> ${res.statusCode}`);
    }
    expect(open).toEqual([]);
  });
});

// Tabel berisi baris yang boleh terbaca role aplikasi dalam mode portal. Menambah tabel ke daftar
// ini berarti membuka data baru untuk orang tua, jadi harus berupa keputusan sadar.
const PORTAL_READABLE = [
  'appointments',
  'guardians',
  'invoices',
  'memberships',
  'organizations',
  'patient_packages',
  'patients',
  'payments',
  'therapy_notes',
  'therapy_services',
  'users',
];

describe('RLS mode portal (lapisan database)', () => {
  let memberId: string;
  const settings = (t: Tenant = A) => ({
    'app.mode': 'portal',
    'app.org_id': t.orgId,
    'app.member_id': memberId,
    'app.scope_patient': 'none',
    'app.scope_note': 'none',
    'app.scope_finance': 'none',
    'app.scope_audit': 'none',
  });

  beforeAll(async () => {
    const guardianId = await addGuardian(admin, A.patientId);
    await activateGuardian(admin, guardianId);
    const { rows } = await env.adminPool.query(`SELECT member_id FROM guardians WHERE id = $1`, [guardianId]);
    memberId = rows[0].member_id;
    await env.adminPool.query(
      `INSERT INTO therapy_notes (organization_id, patient_id, author_member_id, note_type, observations) VALUES ($1, $2, $3, 'sesi', 'DEMO rahasia klinis')`,
      [A.orgId, A.patientId, A.therapist.memberId],
    );
  });

  it('catatan: hanya final milik anak sendiri; draf, revisi, dan anak lain tertutup', async () => {
    const insert = (patientId: string, status: string, text: string) =>
      env.adminPool.query(
        `INSERT INTO therapy_notes (organization_id, patient_id, author_member_id, note_type, status, observations, finalized_at)
         VALUES ($1, $2, $3, 'sesi', $4, $5, CASE WHEN $4 = 'final' THEN now() END)`,
        [A.orgId, patientId, A.therapist.memberId, status, text],
      );
    await insert(A.patientId, 'final', 'DEMO final anak sendiri');
    await insert(A.patient2Id, 'final', 'DEMO final anak lain');
    const seen = await withTx(env.appPool, { readOnly: true, settings: settings() }, async (db) => ({
      notes: await db.many<{ status: string; patientId: string; observations: string }>(`SELECT status, patient_id, observations FROM therapy_notes`),
      revisions: await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM therapy_note_revisions`),
    }));
    expect(seen.notes.length).toBeGreaterThan(0);
    expect(seen.notes.every((n) => n.status === 'final' && n.patientId === A.patientId)).toBe(true);
    expect(seen.notes.map((n) => n.observations)).toContain('DEMO final anak sendiri');
    expect(seen.revisions.n).toBe(0);
  });

  it('hanya baris anak sendiri yang terlihat, tanpa draf catatan, dokumen, audit, maupun wali lain', async () => {
    const seen = await withTx(env.appPool, { readOnly: true, settings: settings() }, async (db) => ({
      patients: await db.many<{ id: string }>(`SELECT id FROM patients`),
      guardians: await db.many<{ memberId: string }>(`SELECT member_id FROM guardians`),
      otherAppointments: await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM appointments WHERE patient_id <> $1`, [A.patientId]),
      drafts: await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM therapy_notes WHERE status <> 'final'`),
      documents: await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM patient_documents`),
      audit: await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs`),
      otherPayments: await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM payments WHERE patient_id <> $1`, [A.patientId]),
    }));
    expect(seen.patients.map((p) => p.id)).toEqual([A.patientId]);
    expect(seen.guardians.every((g) => g.memberId === memberId)).toBe(true);
    expect(seen).toMatchObject({ otherAppointments: { n: 0 }, drafts: { n: 0 }, documents: { n: 0 }, audit: { n: 0 }, otherPayments: { n: 0 } });
  });

  it('seluruh tabel: yang terbaca dalam mode portal hanya yang memang disetujui', async () => {
    const { rows } = await env.adminPool.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`);
    const readable: string[] = [];
    for (const { tablename } of rows) {
      const n = await withTx(env.appPool, { readOnly: true, settings: settings() }, (db) => db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${tablename}`)).catch(
        (err) => {
          if (err.code === '42501') return { n: 0 };
          throw err;
        },
      );
      if (n.n > 0) readable.push(tablename);
    }
    expect(readable).toEqual(PORTAL_READABLE);
  });

  it('akun orang tua lain tidak terbaca, sedangkan nama staf tetap terbaca', async () => {
    const { rows } = await env.adminPool.query<{ userId: string }>(
      `SELECT user_id AS "userId" FROM memberships WHERE organization_id = $1 AND role = 'wali' AND id <> $2 LIMIT 1`,
      [A.orgId, memberId],
    );
    expect(rows).toHaveLength(1);
    const seen = await withTx(env.appPool, { readOnly: true, settings: { ...settings(), 'app.user_id': 'dd0f3b1e-0000-4000-8000-000000000000' } }, async (db) => ({
      otherParentUser: await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [rows[0].userId]),
      otherParentMember: await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM memberships WHERE role = 'wali' AND id <> $1`, [memberId]),
      therapist: await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE id = $1`, [A.therapist.userId]),
    }));
    expect(seen).toEqual({ otherParentUser: { n: 0 }, otherParentMember: { n: 0 }, therapist: { n: 1 } });
  });

  it('member_id dari organisasi lain tidak melihat apa pun', async () => {
    const n = await withTx(env.appPool, { readOnly: true, settings: settings(B) }, (db) => db.one<{ n: number }>(`SELECT count(*)::int AS n FROM patients`));
    expect(n.n).toBe(0);
  });

  it('transaksi portal tidak dapat mengubah data, dan kebijakan tulis tidak terbuka untuk mode portal', async () => {
    await expect(
      withTx(env.appPool, { readOnly: true, settings: settings() }, (db) => db.exec(`UPDATE patients SET nickname = 'x'`)),
    ).rejects.toThrow(/read-only/);
    const changed = await withTx(env.appPool, { settings: settings() }, (db) => db.exec(`UPDATE patients SET nickname = 'x'`));
    expect(changed).toBe(0);
  });

  it('di luar mode portal, fungsi penentu wali selalu false', async () => {
    const r = await withTx(env.appPool, { settings: { ...settings(), 'app.mode': 'tenant' } }, (db) =>
      db.one<{ ok: boolean }>(`SELECT app_is_guardian($1, $2) AS ok`, [A.orgId, A.patientId]),
    );
    expect(r.ok).toBe(false);
  });

  it('tautan wali hanya dapat diubah dengan token undangan untuk baris wali itu sendiri', async () => {
    const target = await addGuardian(admin, A.patient2Id);
    const other = await addGuardian(admin, A.patient2Id);
    const invite = json(await admin.post(`/api/guardians/${target}/invite`));
    const hash = sha256Hex(tokenFrom(invite.url));
    const update = (id: string) =>
      withTx(env.appPool, { settings: { 'app.mode': 'auth', 'app.token_hash': hash } }, (db) => db.exec(`UPDATE guardians SET member_id = $2 WHERE id = $1`, [id, memberId]));
    expect(await update(other)).toBe(0);
    expect(await update(target)).toBe(1);
  });
});
