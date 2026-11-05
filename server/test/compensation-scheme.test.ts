import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTenant, json, login, setupEnv, type Agent, type Tenant, type TestEnv } from './helpers.ts';

// Skema honor diatur sekaligus per terapis (PUT /compensation/schemes/:memberId).
// Bulan uji tetap agar hasil tidak bergantung tanggal test dijalankan.
let env: TestEnv;
let A: Tenant;
let B: Tenant;
let owner: Agent;
let otherServiceId: string;

const put = (memberId: string, body: object, agent = owner) => agent.put(`/api/compensation/schemes/${memberId}`, body);
const schemes = async (month: string, agent = owner) => json(await agent.get(`/api/compensation/schemes?month=${month}`));
const schemeOf = async (memberId: string, month: string) => (await schemes(month)).find((s: any) => s.memberId === memberId);
const monthlyOf = async (memberId: string, month: string) =>
  json(await owner.get(`/api/compensation/monthly?month=${month}`)).therapists.find((t: any) => t.memberId === memberId);

async function completedSession(therapistMemberId: string, patientId: string, serviceId: string, date: string) {
  const r = json(await owner.post('/api/appointments', { patientId, therapistMemberId, serviceId, date, time: '10:00', billing: 'per_sesi', price: 200000 }));
  expect((await owner.post(`/api/appointments/${r.ids[0]}/complete`)).statusCode).toBe(200);
  const { rows } = await env.adminPool.query(`SELECT amount FROM therapist_compensations WHERE appointment_id = $1 AND status <> 'dibatalkan'`, [r.ids[0]]);
  return rows[0]?.amount as number | undefined;
}

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  B = await buildTenant(env.adminPool, 'B');
  owner = await login(env.app, A.owner.email);
  const { rows } = await env.adminPool.query<{ id: string }>(
    `INSERT INTO therapy_services (organization_id, name, default_price) VALUES ($1, 'Terapi Okupasi', 180000) RETURNING id`,
    [A.orgId],
  );
  otherServiceId = rows[0].id;
});
afterAll(() => env.close());

describe('Skema honor diatur sekaligus', () => {
  const T = () => A.therapist.memberId;

  it('pengaturan pertama: gaji pokok, beberapa tunjangan, per sesi umum, dan tarif khusus layanan', async () => {
    const res = await put(T(), {
      effectiveMonth: '2026-08',
      baseSalary: 3_000_000,
      allowances: [
        { name: 'Tunjangan transport', amount: 500_000 },
        { name: 'Tunjangan makan', amount: 300_000 },
      ],
      perSession: { scheme: 'tetap_per_sesi', amount: 50_000 },
      serviceRates: [{ serviceId: A.serviceId, scheme: 'tetap_per_sesi', amount: 75_000 }],
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).changes).toEqual({ diakhiri: 0, dihapus: 0, dibuat: 5 });

    const s = await schemeOf(T(), '2026-08');
    expect(s).toMatchObject({ baseSalary: 3_000_000, perSession: { scheme: 'tetap_per_sesi', amount: 50_000 } });
    expect(s.allowances.map((a: any) => a.name).sort()).toEqual(['Tunjangan makan', 'Tunjangan transport']);
    expect(s.serviceRates).toMatchObject([{ serviceId: A.serviceId, amount: 75_000 }]);

    // Tarif khusus layanan diutamakan; layanan lain memakai tarif umum.
    expect(await completedSession(T(), A.patientId, A.serviceId, '2026-08-10')).toBe(75_000);
    expect(await completedSession(T(), A.patientId, otherServiceId, '2026-08-11')).toBe(50_000);
    expect(await monthlyOf(T(), '2026-08')).toMatchObject({ fixedTotal: 3_800_000, sessionTotal: 125_000, total: 3_925_000 });
  });

  it('menyimpan ulang tanpa perubahan tidak membuat baris baru', async () => {
    const s = await schemeOf(T(), '2026-08');
    const res = json(
      await put(T(), {
        effectiveMonth: '2026-09',
        baseSalary: s.baseSalary,
        allowances: s.allowances,
        perSession: s.perSession,
        serviceRates: s.serviceRates.map((r: any) => ({ serviceId: r.serviceId, scheme: r.scheme, amount: r.amount })),
      }),
    );
    expect(res.changes).toEqual({ diakhiri: 0, dihapus: 0, dibuat: 0 });
  });

  it('kenaikan gaji mulai bulan berikutnya: bulan sebelumnya tidak berubah, tunjangan yang sama tetap', async () => {
    const res = json(
      await put(T(), {
        effectiveMonth: '2026-11',
        baseSalary: 3_500_000,
        allowances: [
          { name: 'Tunjangan transport', amount: 500_000 },
          { name: 'Tunjangan jabatan', amount: 250_000 },
        ],
        perSession: { scheme: 'persen_tarif', percent: 40 },
        serviceRates: [{ serviceId: A.serviceId, scheme: 'tetap_per_sesi', amount: 75_000 }],
      }),
    );
    // Diakhiri: gaji pokok lama, tunjangan makan, tarif umum lama. Dibuat: gaji baru, jabatan, tarif umum baru.
    expect(res.changes).toEqual({ diakhiri: 3, dihapus: 0, dibuat: 3 });
    expect((await monthlyOf(T(), '2026-10')).fixedTotal).toBe(3_800_000);
    expect((await monthlyOf(T(), '2026-11')).fixedTotal).toBe(3_500_000 + 500_000 + 250_000);
    expect((await schemeOf(T(), '2026-10')).upcomingMonth).toBe('2026-11');
    expect((await schemeOf(T(), '2026-11')).perSession).toMatchObject({ scheme: 'persen_tarif' });
  });

  it('koreksi di bulan yang sama mengganti baris yang belum dibayar, bukan menumpuk', async () => {
    const res = json(
      await put(T(), {
        effectiveMonth: '2026-11',
        baseSalary: 3_500_000,
        allowances: [
          { name: 'Tunjangan transport', amount: 500_000 },
          { name: 'Tunjangan jabatan', amount: 300_000 },
        ],
        perSession: { scheme: 'persen_tarif', percent: 40 },
        serviceRates: [{ serviceId: A.serviceId, scheme: 'tetap_per_sesi', amount: 75_000 }],
      }),
    );
    expect(res.changes).toEqual({ diakhiri: 0, dihapus: 1, dibuat: 1 });
    expect((await monthlyOf(T(), '2026-11')).fixedTotal).toBe(4_300_000);
    const { rows } = await env.adminPool.query(
      `SELECT count(*)::int AS n FROM compensation_components WHERE member_id = $1 AND name = 'Tunjangan jabatan'`,
      [T()],
    );
    expect(rows[0].n).toBe(1);
  });

  it('bulan yang sudah dibayar terlindungi: perubahan harus berlaku setelahnya', async () => {
    const m = await monthlyOf(T(), '2026-11');
    const base = m.fixed.find((f: any) => f.kind === 'gaji_pokok');
    expect(json(await owner.post('/api/compensation/components/mark-paid', { month: '2026-11', componentIds: [base.componentId], paidOn: '2026-11-25' })).updated).toBe(1);

    const onlyPerSession = { baseSalary: null, allowances: [], perSession: { scheme: 'tetap_per_sesi', amount: 60_000 }, serviceRates: [] };
    expect((await put(T(), { effectiveMonth: '2026-11', ...onlyPerSession })).statusCode).toBe(409);
    const ok = await put(T(), { effectiveMonth: '2026-12', ...onlyPerSession });
    expect(ok.statusCode).toBe(200);

    // Desember: hanya per sesi. November tetap seperti yang sudah dibayar.
    expect(await monthlyOf(T(), '2026-12')).toMatchObject({ hasBaseSalary: false, hasAllowance: false, hasPerSession: true, fixedTotal: 0 });
    expect((await monthlyOf(T(), '2026-11')).fixedTotal).toBe(4_300_000);
    expect(await schemeOf(T(), '2026-12')).toMatchObject({ baseSalary: null, allowances: [], serviceRates: [], perSession: { amount: 60_000 } });
  });

  it('tarif per sesi yang sudah dipakai menghitung honor tidak dapat diganti di bulan yang sama', async () => {
    const t2 = A.therapist2.memberId;
    expect((await put(t2, { effectiveMonth: '2026-07', perSession: { scheme: 'tetap_per_sesi', amount: 60_000 } })).statusCode).toBe(200);
    expect(await completedSession(t2, A.patient2Id, A.serviceId, '2026-07-10')).toBe(60_000);
    expect((await put(t2, { effectiveMonth: '2026-07', perSession: { scheme: 'tetap_per_sesi', amount: 70_000 } })).statusCode).toBe(409);
    expect((await put(t2, { effectiveMonth: '2026-08', perSession: { scheme: 'tetap_per_sesi', amount: 70_000 } })).statusCode).toBe(200);
    expect(await completedSession(t2, A.patient2Id, A.serviceId, '2026-08-12')).toBe(70_000);
  });

  it('validasi isian', async () => {
    const bad = (body: object) => put(T(), { effectiveMonth: '2027-01', ...body });
    expect((await bad({ allowances: [{ name: 'Makan', amount: 1 }, { name: 'makan', amount: 2 }] })).statusCode).toBe(400);
    expect((await bad({ perSession: { scheme: 'persen_tarif', percent: 120 } })).statusCode).toBe(400);
    expect((await bad({ perSession: { scheme: 'tetap_per_sesi' } })).statusCode).toBe(400);
    expect((await bad({ baseSalary: 0 })).statusCode).toBe(400);
    expect((await bad({ serviceRates: [{ serviceId: B.serviceId, scheme: 'tetap_per_sesi', amount: 1 }] })).statusCode).toBe(400);
    expect((await put(A.finance.memberId, { effectiveMonth: '2027-01', baseSalary: 1 })).statusCode).toBe(400);
    expect((await owner.put(`/api/compensation/schemes/${T()}`, { effectiveMonth: '2027-1' })).statusCode).toBe(400);
  });

  it('hak akses: hanya owner yang mengatur; terapis hanya melihat skemanya sendiri; organisasi lain tertutup', async () => {
    const finance = await login(env.app, A.finance.email);
    expect((await finance.get('/api/compensation/schemes?month=2026-11')).statusCode).toBe(200);
    expect((await put(T(), { effectiveMonth: '2027-01', baseSalary: 1 }, finance)).statusCode).toBe(403);
    const admin = await login(env.app, A.admin.email);
    expect((await admin.get('/api/compensation/schemes?month=2026-11')).statusCode).toBe(403);

    const t2 = await login(env.app, A.therapist2.email);
    expect((await schemes('2026-11', t2)).map((s: any) => s.memberId)).toEqual([A.therapist2.memberId]);
    expect((await put(A.therapist2.memberId, { effectiveMonth: '2027-01', baseSalary: 1 }, t2)).statusCode).toBe(403);

    const ownerB = await login(env.app, B.owner.email);
    expect((await schemes('2026-11', ownerB)).some((s: any) => s.memberId === T())).toBe(false);
    expect((await put(T(), { effectiveMonth: '2027-01', baseSalary: 1 }, ownerB)).statusCode).toBe(400);
    const { rows } = await env.adminPool.query(`SELECT action, meta FROM audit_logs WHERE organization_id = $1 AND action = 'kompensasi.skema_diatur'`, [A.orgId]);
    expect(rows.length).toBeGreaterThanOrEqual(5);
  });
});
