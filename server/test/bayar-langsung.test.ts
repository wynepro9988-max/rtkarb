import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTenant, createPatient, json, localDate, login, setupEnv, type Agent, type Tenant, type TestEnv } from './helpers.ts';

// Permintaan owner 6 Nov 2026: pembayaran langsung untuk paket baru atau "sekali datang" dari formulir
// Catat pembayaran; tab Paket hanya untuk memantau/koreksi. Semua data uji adalah data DEMO.
let env: TestEnv;
let A: Tenant;
let owner: Agent;
let finance: Agent;
const TODAY = localDate(0);

const pay = (agent: Agent, body: object) => agent.post('/api/payments', { method: 'tunai', paidOn: TODAY, ...body });
const packagesOf = async (patientId: string) => json(await owner.get(`/api/patients/${patientId}/packages`));
const unpaidOf = async (patientId: string) => json(await owner.get(`/api/patients/${patientId}/unpaid-sessions`));
const absen = (patientId: string, date = TODAY) =>
  owner.post('/api/absen', { patientId, serviceId: A.serviceId, therapistMemberId: A.therapist.memberId, date, time: '09:00' });

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  owner = await login(env.app, A.owner.email);
  finance = await login(env.app, A.finance.email);
});
afterAll(() => env.close());

describe('Bayar paket baru langsung dari Catat pembayaran', () => {
  it('lunas: paket dibuat bertanggal beli = tanggal bayar dan kuitansi langsung untuk paket itu', async () => {
    const patientId = await createPatient(env.adminPool, A.orgId, 'Bayar1');
    const res = await pay(finance, { patientId, amount: 1_000_000, newPackage: { packageTypeId: A.packageTypeId } });
    expect(res.statusCode).toBe(201);
    const [pkg] = await packagesOf(patientId);
    expect(pkg).toMatchObject({ name: 'Paket 8 Sesi', sessionsRemaining: 8, price: 1_000_000, paidAmount: 1_000_000, purchasedOn: TODAY, isVisit: false });
    const [row] = json(await owner.get(`/api/patients/${patientId}/payments`));
    expect(row).toMatchObject({ receiptNo: json(res).receiptNo, packageName: 'Paket 8 Sesi' });
    // Absen berikutnya memakai paket itu.
    expect(json(await absen(patientId))).toMatchObject({ billing: 'paket', sessionsRemaining: 7 });
  });

  it('DP: sisanya menjadi piutang paket; melebihi harga ditolak tanpa paket tertinggal', async () => {
    const patientId = await createPatient(env.adminPool, A.orgId, 'Bayar2');
    expect((await pay(owner, { patientId, amount: 1_000_001, newPackage: { packageTypeId: A.packageTypeId } })).statusCode).toBe(400);
    expect(await packagesOf(patientId)).toEqual([]);
    expect((await pay(owner, { patientId, amount: 400_000, newPackage: { packageTypeId: A.packageTypeId } })).statusCode).toBe(201);
    const [pkg] = await packagesOf(patientId);
    const owing = json(await owner.get('/api/finance/outstanding')).packages.find((p: any) => p.patientPackageId === pkg.id);
    expect(owing).toMatchObject({ outstanding: 600_000 });
    // Pelunasan lewat paket yang sudah ada.
    expect((await pay(owner, { patientId, amount: 600_000, patientPackageId: pkg.id })).statusCode).toBe(201);
    expect(json(await owner.get('/api/finance/outstanding')).packages.some((p: any) => p.patientPackageId === pkg.id)).toBe(false);
  });

  it('hanya satu tujuan per pembayaran; admin tanpa izin keuangan ditolak', async () => {
    const patientId = await createPatient(env.adminPool, A.orgId, 'Bayar3');
    const both = { patientId, amount: 150_000, newPackage: { packageTypeId: A.packageTypeId }, prepaidVisit: { serviceId: A.serviceId } };
    expect((await pay(owner, both)).statusCode).toBe(400);
    const admin = await login(env.app, A.admin.email);
    expect((await pay(admin, { patientId, amount: 150_000, prepaidVisit: { serviceId: A.serviceId } })).statusCode).toBe(403);
  });
});

describe('Sekali datang', () => {
  it('dibayar sebelum sesi: kunjungan prabayar terpakai otomatis saat diabsen, bukan tagihan per sesi', async () => {
    const patientId = await createPatient(env.adminPool, A.orgId, 'Datang1');
    expect((await pay(owner, { patientId, amount: 150_000, prepaidVisit: { serviceId: A.serviceId } })).statusCode).toBe(201);
    const [visit] = await packagesOf(patientId);
    expect(visit).toMatchObject({ name: 'Sekali datang Terapi Wicara', sessionsTotal: 1, price: 150_000, paidAmount: 150_000, isVisit: true });
    // Kunjungan prabayar tidak ikut peringatan "paket hampir habis" di dasbor.
    expect(json(await owner.get('/api/dashboard')).lowPackages.some((p: any) => p.id === visit.id)).toBe(false);

    expect(json(await absen(patientId))).toMatchObject({ billing: 'paket', sessionsRemaining: 0 });
    expect(await unpaidOf(patientId)).toEqual([]);
    expect((await packagesOf(patientId))[0]).toMatchObject({ status: 'selesai', sessionsRemaining: 0 });
  });

  it('dibayar setelah sesi: sesi yang sudah diabsen muncul sebagai belum dibayar lalu lunas', async () => {
    const patientId = await createPatient(env.adminPool, A.orgId, 'Datang2');
    expect(json(await absen(patientId, localDate(-1)))).toMatchObject({ billing: 'per_sesi', price: 150_000 });
    const [s] = await unpaidOf(patientId);
    expect(s).toMatchObject({ serviceId: A.serviceId, serviceName: 'Terapi Wicara', status: 'selesai', localDate: localDate(-1), outstanding: 150_000 });
    expect((await pay(owner, { patientId, amount: 150_000, appointmentId: s.appointmentId })).statusCode).toBe(201);
    expect(await unpaidOf(patientId)).toEqual([]);
  });

  it('tarif layanan belum diatur: kunjungan prabayar ditolak; nominal di atas tarif ditolak', async () => {
    const patientId = await createPatient(env.adminPool, A.orgId, 'Datang3');
    const { rows } = await env.adminPool.query<{ id: string }>(
      `INSERT INTO therapy_services (organization_id, name, default_price) VALUES ($1, 'DEMO Layanan Tanpa Tarif', 0) RETURNING id`,
      [A.orgId],
    );
    expect((await pay(owner, { patientId, amount: 85_000, prepaidVisit: { serviceId: rows[0].id } })).statusCode).toBe(400);
    expect((await pay(owner, { patientId, amount: 150_001, prepaidVisit: { serviceId: A.serviceId } })).statusCode).toBe(400);
    expect(await packagesOf(patientId)).toEqual([]);
  });

  it('daftar sesi belum dibayar hanya untuk yang berizin melihat pembayaran', async () => {
    const t = await login(env.app, A.therapist.email);
    expect((await t.get(`/api/patients/${A.patientId}/unpaid-sessions`)).statusCode).toBe(403);
  });
});

describe('Admin diberi akses mengubah tarif & harga paket', () => {
  it('owner mengaktifkan per admin; tanpa centang tetap ditolak; pindah peran melepas akses', async () => {
    const admin = await login(env.app, A.admin.email);
    const setPrice = () => admin.patch(`/api/package-types/${A.packageTypeId}`, { price: 1_050_000 });
    expect((await setPrice()).statusCode).toBe(403);
    expect((await admin.patch(`/api/services/${A.serviceId}`, { defaultPrice: 160_000 })).statusCode).toBe(403);

    expect((await owner.patch(`/api/staff/${A.admin.memberId}`, { managesCatalog: true })).statusCode).toBe(200);
    const staff = json(await owner.get('/api/staff')).find((m: any) => m.id === A.admin.memberId);
    expect(staff).toMatchObject({ managesCatalog: true, handlesFinance: false });
    // Berlaku langsung pada sesi admin yang sedang masuk.
    expect((await setPrice()).statusCode).toBe(200);
    expect((await admin.patch(`/api/services/${A.serviceId}`, { defaultPrice: 160_000 })).statusCode).toBe(200);
    const me = json(await admin.get('/api/auth/me'));
    expect(me.permissions).toContain('catalog.manage');
    expect(me.permissions).not.toContain('org.settings.manage');
    // Admin tidak dapat memberi akses ini ke staf lain.
    expect((await admin.patch(`/api/staff/${A.therapist2.memberId}`, { managesCatalog: true })).statusCode).toBe(403);
    expect((await owner.patch(`/api/staff/${A.therapist2.memberId}`, { managesCatalog: true })).statusCode).toBe(400);

    expect((await owner.patch(`/api/staff/${A.admin.memberId}`, { role: 'keuangan' })).statusCode).toBe(200);
    const { rows } = await env.adminPool.query(`SELECT manages_catalog FROM memberships WHERE id = $1`, [A.admin.memberId]);
    expect(rows[0].manages_catalog).toBe(false);
  });
});
