import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../src/db.ts';
import { buildTenant, json, login, setupEnv, unzipAll, type Agent, type Tenant, type TestEnv } from './helpers.ts';

// Skema honor: gaji pokok + tunjangan (bulanan) + honor per sesi, atau hanya per sesi.
// Bulan uji tetap (September 2026) agar hasil tidak bergantung tanggal test dijalankan.
let env: TestEnv;
let A: Tenant;
let B: Tenant;
let owner: Agent;

const MONTH = '2026-09';
const monthly = (agent: Agent, month = MONTH) => agent.get(`/api/compensation/monthly?month=${month}`);
const row = (body: any, memberId: string) => body.therapists.find((t: any) => t.memberId === memberId);

async function completedSession(t: Tenant, therapistMemberId: string, patientId: string, date: string) {
  const agent = await login(env.app, t.owner.email);
  const r = json(await agent.post('/api/appointments', { patientId, therapistMemberId, serviceId: t.serviceId, date, time: '10:00', billing: 'per_sesi', price: 200000 }));
  expect((await agent.post(`/api/appointments/${r.ids[0]}/complete`)).statusCode).toBe(200);
  return r.ids[0] as string;
}

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  B = await buildTenant(env.adminPool, 'B');
  owner = await login(env.app, A.owner.email);
});
afterAll(() => env.close());

describe('Gaji pokok, tunjangan, dan honor per sesi', () => {
  const ids: Record<string, string> = {};

  it('gaji pokok + tunjangan + per sesi: rekap bulanan menjumlahkan semuanya', async () => {
    const add = async (body: object) => {
      const res = await owner.post('/api/compensation/components', { memberId: A.therapist.memberId, ...body });
      expect(res.statusCode).toBe(201);
      return json(res).id as string;
    };
    ids.salary = await add({ kind: 'gaji_pokok', name: 'Gaji pokok', amount: 3_000_000, startMonth: '2026-08' });
    ids.transport = await add({ kind: 'tunjangan', name: 'Tunjangan transport', amount: 500_000, startMonth: MONTH });
    ids.meal = await add({ kind: 'tunjangan', name: 'Tunjangan makan', amount: 300_000, startMonth: MONTH, endMonth: MONTH });
    expect(
      (await owner.post('/api/compensation/rules', { memberId: A.therapist.memberId, scheme: 'tetap_per_sesi', amount: 50_000, effectiveFrom: '2026-01-01' })).statusCode,
    ).toBe(201);
    await completedSession(A, A.therapist.memberId, A.patientId, '2026-09-15');
    await completedSession(A, A.therapist.memberId, A.patientId, '2026-09-16');

    const t = row(json(await monthly(owner)), A.therapist.memberId);
    expect(t).toMatchObject({
      hasBaseSalary: true,
      hasAllowance: true,
      hasPerSession: true,
      fixedTotal: 3_800_000,
      sessions: 2,
      sessionTotal: 100_000,
      total: 3_900_000,
      unpaid: 3_900_000,
      paid: 0,
    });
    expect(t.fixed.map((f: any) => f.name).sort()).toEqual(['Gaji pokok', 'Tunjangan makan', 'Tunjangan transport']);

    // Tunjangan makan hanya untuk September; Agustus belum ada tunjangan sama sekali.
    expect(row(json(await monthly(owner, '2026-10')), A.therapist.memberId)).toMatchObject({ fixedTotal: 3_500_000, sessions: 0, total: 3_500_000 });
    expect(row(json(await monthly(owner, '2026-08')), A.therapist.memberId)).toMatchObject({ fixedTotal: 3_000_000, hasAllowance: false });
  });

  it('hanya per sesi: tanpa gaji pokok maupun tunjangan', async () => {
    await owner.post('/api/compensation/rules', { memberId: A.therapist2.memberId, scheme: 'persen_tarif', percent: 40, effectiveFrom: '2026-01-01' });
    await completedSession(A, A.therapist2.memberId, A.patient2Id, '2026-09-20');
    expect(row(json(await monthly(owner)), A.therapist2.memberId)).toMatchObject({
      hasBaseSalary: false,
      hasAllowance: false,
      hasPerSession: true,
      fixed: [],
      fixedTotal: 0,
      sessions: 1,
      sessionTotal: 80_000,
      total: 80_000,
    });
  });

  it('gaji pokok tidak boleh tumpang tindih; kenaikan gaji = akhiri lama lalu buat baru; validasi isian', async () => {
    const second = { memberId: A.therapist.memberId, kind: 'gaji_pokok', name: 'Gaji pokok', amount: 3_500_000, startMonth: '2026-11' };
    expect((await owner.post('/api/compensation/components', second)).statusCode).toBe(409);
    expect((await owner.post(`/api/compensation/components/${ids.salary}/end`, { endMonth: '2026-10' })).statusCode).toBe(200);
    expect((await owner.post('/api/compensation/components', second)).statusCode).toBe(201);
    expect(row(json(await monthly(owner, '2026-11')), A.therapist.memberId).fixedTotal).toBe(3_500_000 + 500_000);
    expect(row(json(await monthly(owner, '2026-10')), A.therapist.memberId).fixedTotal).toBe(3_000_000 + 500_000);

    const bad = (body: object) => owner.post('/api/compensation/components', { ...second, kind: 'tunjangan', name: 'Tunjangan jabatan', ...body });
    expect((await bad({ startMonth: '2026-13' })).statusCode).toBe(400);
    expect((await bad({ endMonth: '2026-10' })).statusCode).toBe(400);
    expect((await bad({ amount: 0 })).statusCode).toBe(400);
    expect((await bad({ name: 'x' })).statusCode).toBe(400);
    expect((await bad({ memberId: A.finance.memberId })).statusCode).toBe(400);
    expect((await owner.get('/api/compensation/monthly?month=2026-9')).statusCode).toBe(400);
  });

  it('tandai dibayar: nominal dibekukan, tidak dapat dibayar dua kali, dan bulan akhir tidak boleh sebelum bulan yang sudah dibayar', async () => {
    const pay = (componentIds: string[], month = MONTH) => owner.post('/api/compensation/components/mark-paid', { month, componentIds, paidOn: '2026-09-30' });
    expect(json(await pay([ids.salary, ids.transport, ids.meal])).updated).toBe(3);
    expect(json(await pay([ids.salary])).updated).toBe(0);
    // Tunjangan makan tidak berlaku di Oktober.
    expect(json(await pay([ids.meal], '2026-10')).updated).toBe(0);

    const t = row(json(await monthly(owner)), A.therapist.memberId);
    expect(t).toMatchObject({ paid: 3_800_000, unpaid: 100_000 });
    expect(t.fixed.every((f: any) => f.paidOn)).toBe(true);

    expect((await owner.post(`/api/compensation/components/${ids.transport}/end`, { endMonth: '2026-08' })).statusCode).toBe(400);

    const { rows } = await env.adminPool.query(`SELECT name, amount FROM compensation_component_payouts WHERE component_id = $1`, [ids.salary]);
    expect(rows).toEqual([{ name: 'Gaji pokok', amount: 3_000_000 }]);
  });

  it('hak akses: terapis hanya miliknya, keuangan melihat tanpa mengubah, admin dan organisasi lain tertutup', async () => {
    const t2 = await login(env.app, A.therapist2.email);
    const own = json(await monthly(t2));
    expect(own.therapists.map((t: any) => t.memberId)).toEqual([A.therapist2.memberId]);
    expect(json(await t2.get('/api/compensation/components')).length).toBe(0);
    const t1 = await login(env.app, A.therapist.email);
    expect(json(await t1.get('/api/compensation/components')).every((c: any) => c.memberId === A.therapist.memberId)).toBe(true);

    const finance = await login(env.app, A.finance.email);
    expect(row(json(await monthly(finance)), A.therapist.memberId)).toBeTruthy();
    expect(
      (await finance.post('/api/compensation/components', { memberId: A.therapist2.memberId, kind: 'tunjangan', name: 'Tunjangan', amount: 1, startMonth: MONTH })).statusCode,
    ).toBe(403);
    expect((await finance.post('/api/compensation/components/mark-paid', { month: '2026-11', componentIds: [ids.transport], paidOn: '2026-11-30' })).statusCode).toBe(403);

    const admin = await login(env.app, A.admin.email);
    expect((await monthly(admin)).statusCode).toBe(403);

    const ownerB = await login(env.app, B.owner.email);
    expect(row(json(await monthly(ownerB)), A.therapist.memberId)).toBeUndefined();
    expect(
      (await ownerB.post('/api/compensation/components', { memberId: A.therapist.memberId, kind: 'tunjangan', name: 'Tunjangan', amount: 1, startMonth: MONTH })).statusCode,
    ).toBe(400);
    expect(json(await ownerB.post('/api/compensation/components/mark-paid', { month: '2026-11', componentIds: [ids.transport], paidOn: '2026-11-30' })).updated).toBe(0);
    expect((await ownerB.post(`/api/compensation/components/${ids.transport}/end`, { endMonth: '2026-12' })).statusCode).toBe(404);
  });

  it('RLS: terapis tidak dapat membaca komponen maupun pembayaran terapis lain, dan tidak dapat menulis', async () => {
    const settings = {
      'app.mode': 'tenant',
      'app.org_id': A.orgId,
      'app.member_id': A.therapist2.memberId,
      'app.scope_patient': 'assigned',
      'app.scope_note': 'assigned',
      'app.scope_finance': 'none',
      'app.scope_audit': 'none',
    };
    const seen = await withTx(env.appPool, { settings }, async (db) => ({
      components: (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM compensation_components`)).n,
      payouts: (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM compensation_component_payouts`)).n,
    }));
    expect(seen).toEqual({ components: 0, payouts: 0 });
    await expect(
      withTx(env.appPool, { settings }, (db) =>
        db.exec(
          `INSERT INTO compensation_components (organization_id, member_id, kind, name, amount, start_month) VALUES ($1, $2, 'tunjangan', 'Tunjangan', 1, '2026-09-01')`,
          [A.orgId, A.therapist2.memberId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // Pembayaran bersifat tetap: role aplikasi tidak punya hak UPDATE/DELETE.
    await expect(
      withTx(env.appPool, { settings: { ...settings, 'app.scope_finance': 'all' } }, (db) => db.exec(`UPDATE compensation_component_payouts SET amount = 1`)),
    ).rejects.toThrow(/permission denied/);
  });

  it('laporan keuangan dan ekspor Excel memuat gaji pokok & tunjangan', async () => {
    const r = json(await owner.get(`/api/reports/finance?from=2026-09-01&to=2026-09-30`));
    expect(r.fixedPay).toEqual({ unpaid: 0, paid: 3_800_000 });
    const oct = json(await owner.get(`/api/reports/finance?from=2026-10-01&to=2026-10-31`));
    expect(oct.fixedPay).toEqual({ unpaid: 3_500_000, paid: 0 });
    // Rentang yang tidak memuat tanggal 1 sebuah bulan tidak menghitung gaji bulan itu.
    expect(json(await owner.get(`/api/reports/finance?from=2026-09-02&to=2026-09-30`)).fixedPay).toEqual({ unpaid: 0, paid: 0 });

    const xlsx = await owner.get(`/api/reports/keuangan/export?from=2026-09-01&to=2026-10-31`);
    expect(xlsx.statusCode).toBe(200);
    const xml = unzipAll(xlsx.rawPayload);
    for (const label of ['Gaji &amp; Tunjangan', 'Tunjangan transport', 'gaji pokok', 'belum dibayar']) expect(xml).toContain(label);
  });
});
