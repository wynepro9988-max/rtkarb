import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../src/db.ts';
import { sha256Hex } from '../src/security/tokens.ts';
import { buildTenant, createMember, createUser, json, localDate, login, setupEnv, testPhone, testUsername, uniq, type Tenant, type TestEnv } from './helpers.ts';

let env: TestEnv;
let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  B = await buildTenant(env.adminPool, 'B');
});
afterAll(() => env.close());

const PAYMENTS = '/api/payments?from=2026-01-01&to=2026-12-31';
const tokenFrom = (url: string) => url.split('#token=')[1];

describe('Admin merangkap keuangan (keputusan owner per admin)', () => {
  it('owner membuka akses keuangan untuk satu admin; catatan klinis, pembatalan, dan pengaturan tetap tertutup; dapat dicabut', async () => {
    const m = await createMember(env.adminPool, A.orgId, 'admin', 'rangkap');
    const staff = await login(env.app, m.email);
    const owner = await login(env.app, A.owner.email);
    const payment = { patientId: A.patientId, amount: 25000, method: 'tunai', paidOn: localDate(0) };

    expect((await staff.get(PAYMENTS)).statusCode).toBe(403);
    expect((await staff.post('/api/payments', payment)).statusCode).toBe(403);

    expect((await owner.patch(`/api/staff/${m.memberId}`, { handlesFinance: true })).statusCode).toBe(200);
    const me = json(await staff.get('/api/auth/me'));
    expect(me.membership.roleLabel).toBe('Admin & Keuangan');
    expect(me.membership.handlesFinance).toBe(true);
    expect(me.permissions).toEqual(expect.arrayContaining(['payment.record', 'expense.record', 'invoice.create', 'finance.reconcile', 'report.finance', 'schedule.manage']));
    for (const p of ['therapy.note.read', 'payment.void', 'invoice.discount', 'audit.read', 'org.settings.manage', 'staff.manage', 'whatsapp.manage']) {
      expect(me.permissions).not.toContain(p);
    }

    const created = await staff.post('/api/payments', payment);
    expect(created.statusCode).toBe(201);
    expect((await staff.get(PAYMENTS)).statusCode).toBe(200);
    expect((await staff.post(`/api/payments/${json(created).id}/void`, { reason: 'Salah input nominal' })).statusCode).toBe(403);

    const therapist = await login(env.app, A.therapist.email);
    const note = json(await therapist.post('/api/notes', { patientId: A.patientId, noteType: 'asesmen', observations: 'DEMO asesmen rangkap' }));
    expect((await staff.get(`/api/notes/${note.id}`)).statusCode).toBe(403);

    const { rows } = await env.adminPool.query(
      `SELECT meta FROM audit_logs WHERE organization_id = $1 AND action = 'staf.diubah' AND entity_id = $2`,
      [A.orgId, m.memberId],
    );
    expect(rows[0].meta).toMatchObject({ keuangan_sebelum: false, keuangan_sesudah: true });

    expect((await owner.patch(`/api/staff/${m.memberId}`, { handlesFinance: false })).statusCode).toBe(200);
    expect((await staff.get(PAYMENTS)).statusCode).toBe(403);
  });

  it('hanya admin yang dapat merangkap; pindah peran otomatis melepas rangkap keuangan', async () => {
    const owner = await login(env.app, A.owner.email);
    const t = await createMember(env.adminPool, A.orgId, 'terapis', 'bukanadmin');
    expect((await owner.patch(`/api/staff/${t.memberId}`, { handlesFinance: true })).statusCode).toBe(400);
    const inv = await owner.post('/api/staff/invitations', { phone: testPhone(), fullName: 'DEMO Kasir', role: 'keuangan', handlesFinance: true });
    expect(inv.statusCode).toBe(400);

    const m = await createMember(env.adminPool, A.orgId, 'admin', 'pindahperan');
    await owner.patch(`/api/staff/${m.memberId}`, { handlesFinance: true });
    expect((await owner.patch(`/api/staff/${m.memberId}`, { role: 'terapis' })).statusCode).toBe(200);
    const { rows } = await env.adminPool.query(`SELECT role, handles_finance FROM memberships WHERE id = $1`, [m.memberId]);
    expect(rows[0]).toEqual({ role: 'terapis', handles_finance: false });

    // Lapisan database: kombinasi peran non-admin + rangkap keuangan ditolak.
    await expect(env.adminPool.query(`UPDATE memberships SET handles_finance = true WHERE id = $1`, [m.memberId])).rejects.toThrow(
      /memberships_handles_finance_admin/,
    );
  });

  it('undangan admin merangkap keuangan terbawa saat aktivasi, dan kebijakan database menolak aktivasi yang menambah akses', async () => {
    const owner = await login(env.app, A.owner.email);
    const username = testUsername('ak');
    const inv = json(await owner.post('/api/staff/invitations', { phone: testPhone(), fullName: 'DEMO Admin Kasir', role: 'admin', handlesFinance: true }));
    const accept = await env.app.inject({ method: 'POST', url: '/api/auth/accept-invitation', payload: { token: tokenFrom(inv.url), username, password: 'SandiBaruAman#1' } });
    expect(accept.statusCode).toBe(200);
    const staff = await login(env.app, username, 'SandiBaruAman#1');
    const me = json(await staff.get('/api/auth/me'));
    expect(me.membership).toMatchObject({ role: 'admin', handlesFinance: true, roleLabel: 'Admin & Keuangan' });
    expect(me.permissions).toContain('payment.record');

    // Undangan admin biasa tidak dapat dipakai untuk membuat keanggotaan berakses keuangan.
    const plain = json(await owner.post('/api/staff/invitations', { phone: testPhone(), fullName: 'DEMO Admin Biasa', role: 'admin' }));
    const u = await createUser(env.adminPool, 'sisipan');
    const insert = (handlesFinance: boolean) =>
      withTx(env.appPool, { settings: { 'app.mode': 'auth', 'app.token_hash': sha256Hex(tokenFrom(plain.url)) } }, (db) =>
        db.exec(`INSERT INTO memberships (organization_id, user_id, role, handles_finance) VALUES ($1, $2, 'admin', $3)`, [A.orgId, u.userId, handlesFinance]),
      );
    await expect(insert(true)).rejects.toThrow(/row-level security/);
    await expect(insert(false)).resolves.toBe(1);
  });

  it('pengaturan rangkap milik owner A tidak berlaku untuk organisasi B', async () => {
    const ownerB = await login(env.app, B.owner.email);
    expect((await ownerB.post('/api/payments', { patientId: B.patientId, amount: 33333, method: 'tunai', paidOn: localDate(0) })).statusCode).toBe(201);
    expect((await ownerB.patch(`/api/staff/${A.admin.memberId}`, { handlesFinance: true })).statusCode).toBe(404);
    const { rows } = await env.adminPool.query(`SELECT handles_finance FROM memberships WHERE id = $1`, [A.admin.memberId]);
    expect(rows[0].handles_finance).toBe(false);

    const ownerA = await login(env.app, A.owner.email);
    expect((await ownerA.post('/api/payments', { patientId: A.patientId, amount: 44444, method: 'tunai', paidOn: localDate(0) })).statusCode).toBe(201);
    await ownerA.patch(`/api/staff/${A.admin.memberId}`, { handlesFinance: true });
    const adminB = await login(env.app, B.admin.email);
    expect((await adminB.get(PAYMENTS)).statusCode).toBe(403);
    // Admin A yang merangkap keuangan hanya melihat pembayaran A.
    const adminA = await login(env.app, A.admin.email);
    const list = json<any>(await adminA.get(PAYMENTS));
    const items: any[] = Array.isArray(list) ? list : list.items;
    const { rows: bPay } = await env.adminPool.query(`SELECT id FROM payments WHERE organization_id = $1`, [B.orgId]);
    const bIds = new Set(bPay.map((r) => r.id));
    expect(bIds.size).toBeGreaterThan(0);
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((p) => bIds.has(p.id))).toBe(false);
    await ownerA.patch(`/api/staff/${A.admin.memberId}`, { handlesFinance: false });
  });
});
