import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTenant, json, login, setupEnv, type Agent, type Tenant, type TestEnv } from './helpers.ts';

// Keputusan owner 6 Nov 2026: tunjangan per hari hadir, dan paket lama dengan sisa sesi.
// Bulan uji tetap (sudah lewat) agar hasil tidak bergantung tanggal test dijalankan. Data DEMO.
let env: TestEnv;
let A: Tenant;
let owner: Agent;
let admin: Agent;

async function session(therapistMemberId: string, patientId: string, date: string, time: string, complete = true) {
  const r = json(await owner.post('/api/appointments', { patientId, therapistMemberId, serviceId: A.serviceId, date, time, billing: 'tanpa_biaya' }));
  if (complete) expect((await owner.post(`/api/appointments/${r.ids[0]}/complete`)).statusCode).toBe(200);
  return r.ids[0] as string;
}
const monthlyOf = async (month: string, agent = owner, memberId = A.therapist.memberId) =>
  json(await agent.get(`/api/compensation/monthly?month=${month}`)).therapists.find((t: any) => t.memberId === memberId);

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  owner = await login(env.app, A.owner.email);
  admin = await login(env.app, A.admin.email);
});
afterAll(() => env.close());

describe('Tunjangan per hari hadir', () => {
  const T = () => A.therapist.memberId;
  const item = (t: any, name: string) => t.fixed.find((f: any) => f.name === name);

  it('skema menyimpan cara hitung tunjangan; gaji pokok tidak boleh harian', async () => {
    const res = await owner.put(`/api/compensation/schemes/${T()}`, {
      effectiveMonth: '2026-08',
      baseSalary: 1_500_000,
      allowances: [
        { name: 'BPJS', amount: 100_000 },
        { name: 'Tunjangan Operasional', amount: 10_000, basis: 'harian' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const s = json(res);
    expect(s.allowances).toEqual(
      expect.arrayContaining([
        { name: 'BPJS', amount: 100_000, basis: 'bulanan' },
        { name: 'Tunjangan Operasional', amount: 10_000, basis: 'harian' },
      ]),
    );
    // Menyimpan ulang dengan isi sama tidak membuat baris baru; mengganti cara hitung membuat baris baru.
    expect(
      json(
        await owner.put(`/api/compensation/schemes/${T()}`, {
          effectiveMonth: '2026-08',
          baseSalary: 1_500_000,
          allowances: [
            { name: 'BPJS', amount: 100_000 },
            { name: 'Tunjangan Operasional', amount: 10_000, basis: 'harian' },
          ],
        }),
      ).changes,
    ).toEqual({ diakhiri: 0, dihapus: 0, dibuat: 0 });
    const bad = await owner.post('/api/compensation/components', {
      memberId: A.therapist2.memberId,
      kind: 'gaji_pokok',
      name: 'Gaji pokok',
      amount: 1_000_000,
      basis: 'harian',
      startMonth: '2026-08',
    });
    expect(bad.statusCode).toBe(400);
  });

  it('hari hadir = tanggal dengan minimal satu sesi selesai, per zona waktu organisasi', async () => {
    await session(T(), A.patientId, '2026-09-02', '09:00');
    await session(T(), A.patient2Id, '2026-09-02', '13:00'); // tanggal sama: tetap 1 hari
    await session(T(), A.patientId, '2026-09-10', '09:00');
    await session(T(), A.patientId, '2026-09-30', '23:30');
    await session(T(), A.patientId, '2026-09-15', '09:00', false); // belum diabsen: tidak dihitung
    await session(A.therapist2.memberId, A.patientId, '2026-09-20', '09:00'); // terapis lain
    await session(T(), A.patientId, '2026-10-01', '00:30'); // 30 Sep 17:30 UTC, tetapi 1 Okt di WIB

    const sep = await monthlyOf('2026-09');
    expect(item(sep, 'Tunjangan Operasional')).toMatchObject({ basis: 'harian', rate: 10_000, days: 3, amount: 30_000, paidOn: null });
    expect(item(sep, 'BPJS')).toMatchObject({ basis: 'bulanan', days: null, amount: 100_000 });
    expect(sep.fixedTotal).toBe(1_630_000);
    expect(item(await monthlyOf('2026-10'), 'Tunjangan Operasional')).toMatchObject({ days: 1, amount: 10_000 });

    // Terapis melihat hitungan miliknya sendiri.
    const own = await monthlyOf('2026-09', await login(env.app, A.therapist.email));
    expect(item(own, 'Tunjangan Operasional')).toMatchObject({ days: 3, amount: 30_000 });
  });

  it('bulan tanpa hari hadir: tunjangan harian Rp0 dan dilewati saat ditandai dibayar', async () => {
    const aug = await monthlyOf('2026-08');
    expect(item(aug, 'Tunjangan Operasional')).toMatchObject({ days: 0, amount: 0 });
    const ids = aug.fixed.map((f: any) => f.componentId);
    const r = json(await owner.post('/api/compensation/components/mark-paid', { month: '2026-08', componentIds: ids, paidOn: '2026-09-01' }));
    expect(r.updated).toBe(2);
    expect(item(await monthlyOf('2026-08'), 'Tunjangan Operasional').paidOn).toBeNull();
  });

  it('dibayar tanggal 1: nominal & hari dibekukan; absen susulan tidak mengubah yang sudah dibayar', async () => {
    const sep = await monthlyOf('2026-09');
    const ids = sep.fixed.map((f: any) => f.componentId);
    expect(json(await owner.post('/api/compensation/components/mark-paid', { month: '2026-09', componentIds: ids, paidOn: '2026-10-01' })).updated).toBe(3);
    await session(T(), A.patientId, '2026-09-25', '09:00');
    const after = await monthlyOf('2026-09');
    expect(item(after, 'Tunjangan Operasional')).toMatchObject({ days: 3, amount: 30_000, paidOn: '2026-10-01' });
    expect(after.unpaid).toBe(0);
    const { rows } = await env.adminPool.query(`SELECT days, amount FROM compensation_component_payouts WHERE component_id = $1 AND period = '2026-09-01'`, [
      item(after, 'Tunjangan Operasional').componentId,
    ]);
    expect(rows).toEqual([{ days: 3, amount: 30_000 }]);
  });

  it('laporan keuangan & ekspor memakai nominal harian', async () => {
    const sep = json(await owner.get('/api/reports/finance?from=2026-09-01&to=2026-09-30'));
    expect(sep.fixedPay).toEqual({ unpaid: 0, paid: 1_630_000 });
    const oct = json(await owner.get('/api/reports/finance?from=2026-10-01&to=2026-10-31'));
    expect(oct.fixedPay).toEqual({ unpaid: 1_610_000, paid: 0 });
  });
});

describe('Paket lama (sebelum memakai aplikasi)', () => {
  const sell = (agent: Agent, body: object, patientId = A.patientId) => agent.post(`/api/patients/${patientId}/packages`, { packageTypeId: A.packageTypeId, ...body });
  const packages = async (patientId = A.patientId) => json(await owner.get(`/api/patients/${patientId}/packages`));
  const outstanding = async () => json(await owner.get('/api/finance/outstanding')).packages;

  it('lunas di luar aplikasi: sisa sesi tercatat, bukan piutang, bukan pemasukan', async () => {
    const res = await sell(owner, { purchasedOn: '2026-09-15', carriedOver: { sessionsRemaining: 2, paidBefore: 1_000_000 } });
    expect(res.statusCode).toBe(201);
    const id = json(res).id;
    const pkg = (await packages()).find((p: any) => p.id === id);
    expect(pkg).toMatchObject({ sessionsTotal: 8, sessionsUsed: 6, sessionsRemaining: 2, status: 'aktif', carriedOver: true, paidAmount: 1_000_000 });
    const detail = json(await owner.get(`/api/patient-packages/${id}`));
    expect(detail.ledger).toMatchObject([{ kind: 'penyesuaian', sessionsDelta: 6, sessionsUsedAfter: 6 }]);
    expect((await outstanding()).some((p: any) => p.patientPackageId === id)).toBe(false);
    const rep = json(await owner.get('/api/reports/finance?from=2026-09-01&to=2026-09-30'));
    expect(rep.payments.total).toBe(0);
    expect(rep.receivables.packages).toBe(0);
  });

  it('belum lunas: kekurangannya menjadi piutang sampai dibayar', async () => {
    const id = json(await sell(owner, { carriedOver: { sessionsRemaining: 5, paidBefore: 400_000 } }, A.patient2Id)).id;
    expect((await outstanding()).find((p: any) => p.patientPackageId === id)).toMatchObject({ price: 1_000_000, outstanding: 600_000 });
    const pay = await owner.post('/api/payments', { patientId: A.patient2Id, amount: 600_000, method: 'tunai', paidOn: '2026-11-02', patientPackageId: id });
    expect(pay.statusCode).toBe(201);
    expect((await outstanding()).some((p: any) => p.patientPackageId === id)).toBe(false);
  });

  it('validasi dan hak akses: admin hanya dapat menjual paket baru', async () => {
    expect((await sell(admin, { carriedOver: { sessionsRemaining: 2, paidBefore: 1_000_000 } })).statusCode).toBe(403);
    expect((await sell(admin, {})).statusCode).toBe(201);
    expect((await sell(owner, { carriedOver: { sessionsRemaining: 9, paidBefore: 0 } })).statusCode).toBe(400);
    expect((await sell(owner, { carriedOver: { sessionsRemaining: 0, paidBefore: 0 } })).statusCode).toBe(400);
    expect((await sell(owner, { carriedOver: { sessionsRemaining: 2, paidBefore: 1_000_001 } })).statusCode).toBe(400);
    // Nominal "sudah dibayar" hanya untuk paket lama (dijaga juga oleh database).
    await expect(
      env.adminPool.query(
        `INSERT INTO patient_packages (organization_id, patient_id, name, sessions_total, price, purchased_on, opening_paid)
         VALUES ($1, $2, 'DEMO', 8, 1000000, current_date, 1000)`,
        [A.orgId, A.patientId],
      ),
    ).rejects.toThrow(/patient_packages_opening_paid/);
  });

  it('harga paket lama boleh berbeda dari katalog (harga saat dibeli)', async () => {
    const id = json(await sell(owner, { carriedOver: { sessionsRemaining: 3, price: 480_000, paidBefore: 480_000 } })).id;
    expect((await packages()).find((p: any) => p.id === id)).toMatchObject({ price: 480_000, paidAmount: 480_000 });
    expect((await sell(owner, { carriedOver: { sessionsRemaining: 3, price: 480_000, paidBefore: 500_000 } })).statusCode).toBe(400);
  });
});

describe('Pembayaran umum ditautkan ke paket', () => {
  const payUmum = async (amount: number, patientId = A.patientId) =>
    json(await owner.post('/api/payments', { patientId, amount, method: 'tunai', paidOn: '2026-10-25' })) as { id: string; receiptNo: string };
  const oldPackage = async (patientId = A.patientId, price = 480_000) =>
    json(await owner.post(`/api/patients/${patientId}/packages`, { packageTypeId: A.packageTypeId, carriedOver: { sessionsRemaining: 4, price, paidBefore: 0 } })).id as string;
  const link = (paymentId: string, patientPackageId: string, agent = owner) => agent.post(`/api/payments/${paymentId}/link`, { patientPackageId });

  it('kuitansi tetap, paket menjadi lunas, tercatat di audit, dan hanya sekali', async () => {
    const pay = await payUmum(480_000);
    const pkg = await oldPackage();
    expect(json(await owner.get('/api/finance/outstanding')).packages.find((p: any) => p.patientPackageId === pkg)).toMatchObject({ outstanding: 480_000 });
    expect((await link(pay.id, pkg, admin)).statusCode).toBe(403);
    expect((await link(pay.id, pkg)).statusCode).toBe(200);

    const row = json(await owner.get(`/api/patients/${A.patientId}/payments`)).find((p: any) => p.id === pay.id);
    expect(row).toMatchObject({ receiptNo: pay.receiptNo, amount: 480_000, paidOn: '2026-10-25', packageName: 'Paket 8 Sesi', status: 'tercatat' });
    expect(json(await owner.get('/api/finance/outstanding')).packages.some((p: any) => p.patientPackageId === pkg)).toBe(false);
    const { rows } = await env.adminPool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'pembayaran.ditautkan' AND entity_id = $1`, [pay.id]);
    expect(rows[0].n).toBe(1);

    expect((await link(pay.id, await oldPackage())).statusCode).toBe(409);
    // Database juga menolak memindahkan tautan yang sudah ada.
    await expect(
      env.adminPool.query(`UPDATE payments SET patient_package_id = NULL WHERE id = $1`, [pay.id]),
    ).rejects.toThrow(/Hanya pembayaran umum/);
  });

  it('ditolak: paket pasien lain, melebihi sisa tagihan, pembayaran dibatalkan', async () => {
    const pay = await payUmum(300_000);
    expect((await link(pay.id, await oldPackage(A.patient2Id))).statusCode).toBe(400);
    expect((await link(pay.id, await oldPackage(A.patientId, 200_000))).statusCode).toBe(409);
    expect((await owner.post(`/api/payments/${pay.id}/void`, { reason: 'DEMO salah catat' })).statusCode).toBe(200);
    expect((await link(pay.id, await oldPackage())).statusCode).toBe(409);
  });
});
