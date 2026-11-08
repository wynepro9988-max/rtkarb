import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTenant, createPatient, json, localDate, login, setupEnv, type Agent, type Tenant, type TestEnv } from './helpers.ts';

// Permintaan owner 8 Nov 2026: jadwal tanpa terapis ikut tampil di jadwal semua terapis (identitas
// ringkas, bertanda "Belum ada terapis"), dan jadwal menunjukkan sisa tagihan bagi yang berizin melihat
// pembayaran. Belum dibayar tidak menghalangi jadwal. Semua data uji adalah data DEMO.
let env: TestEnv;
let A: Tenant;
let B: Tenant;
let owner: Agent;
let admin: Agent;
let finance: Agent;
let t1: Agent;
let t2: Agent;
const TODAY = localDate(0);
const TOMORROW = localDate(1);
const WEEK = `from=${TODAY}&to=${localDate(6)}`;

const schedule = (agent: Agent, body: object) =>
  agent.post('/api/appointments', { serviceId: A.serviceId, date: TOMORROW, time: '10:00', billing: 'per_sesi', ...body }).then((r) => json(r).ids[0] as string);
const find = async (agent: Agent, id: string, query = WEEK) => json(await agent.get(`/api/appointments?${query}`)).find((a: any) => a.id === id);

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  B = await buildTenant(env.adminPool, 'B');
  owner = await login(env.app, A.owner.email);
  admin = await login(env.app, A.admin.email);
  finance = await login(env.app, A.finance.email);
  t1 = await login(env.app, A.therapist.email);
  t2 = await login(env.app, A.therapist2.email);
});
afterAll(() => env.close());

describe('Jadwal tanpa terapis tampil di semua terapis', () => {
  it('terapis melihat jadwal mendatang tanpa terapis dengan identitas ringkas; data pasien tetap tertutup', async () => {
    const id = await schedule(admin, { patientId: A.patient2Id, time: '09:00' });
    const row = await find(t1, id);
    expect(row).toMatchObject({ therapistMemberId: null, therapistName: null, patientName: 'DEMO Anak A2', serviceName: 'Terapi Wicara', status: 'terjadwal', localDate: TOMORROW, localTime: '09:00' });
    expect(row).toMatchObject({ billing: null, price: null, outstanding: null, adminNotes: null });
    expect(await find(t2, id)).toBeTruthy();
    // Belum tertaut ke pasien itu: profil pasien tidak terbuka.
    expect((await t1.get(`/api/patients/${A.patient2Id}`)).statusCode).toBe(404);
    // Filter status & pasien tetap berlaku.
    expect(await find(t1, id, `${WEEK}&status=selesai`)).toBeUndefined();
    expect(await find(t1, id, `${WEEK}&patientId=${A.patientId}`)).toBeUndefined();
    expect(await find(t1, id, `${WEEK}&patientId=${A.patient2Id}`)).toBeTruthy();
  });

  it('setelah terapis ditetapkan, hanya terapis itu yang melihatnya; jadwal terapis lain tetap tersembunyi', async () => {
    const id = await schedule(owner, { patientId: A.patient2Id, time: '11:00' });
    const moved = json(await owner.post(`/api/appointments/${id}/reschedule`, { date: TOMORROW, time: '11:00', therapistMemberId: A.therapist2.memberId })).id;
    expect(await find(t1, moved)).toBeUndefined();
    expect(await find(t2, moved)).toMatchObject({ therapistMemberId: A.therapist2.memberId });
    // Jadwal lama berstatus dijadwal ulang, tidak lagi muncul sebagai jadwal terbuka.
    expect(await find(t1, id)).toBeUndefined();
  });

  it('jadwal batal dan organisasi lain tidak ikut; dasbor terapis memuat jadwal hari ini tanpa terapis', async () => {
    const cancelled = await schedule(admin, { patientId: A.patient2Id, time: '13:00' });
    expect((await admin.post(`/api/appointments/${cancelled}/cancel`, { reason: 'DEMO batal' })).statusCode).toBe(200);
    expect(await find(t1, cancelled)).toBeUndefined();

    const ownerB = await login(env.app, B.owner.email);
    const other = await ownerB.post('/api/appointments', { patientId: B.patient2Id, serviceId: B.serviceId, date: TOMORROW, time: '10:00', billing: 'per_sesi' });
    expect(await find(t1, json(other).ids[0])).toBeUndefined();

    const today = await schedule(admin, { patientId: A.patient2Id, date: TODAY, time: '07:00' });
    const dash = json(await t1.get('/api/dashboard'));
    expect(dash.todayAppointments.find((a: any) => a.id === today)).toMatchObject({ therapistMemberId: null, patientName: 'DEMO Anak A2' });
  });
});

describe('Sisa tagihan di jadwal', () => {
  it('per sesi: tampil bagi owner & keuangan, berkurang setelah dibayar; admin tanpa keuangan dan terapis tidak melihat', async () => {
    const patientId = await createPatient(env.adminPool, A.orgId, 'Tagih1');
    const id = await schedule(admin, { patientId, therapistMemberId: A.therapist.memberId, time: '14:00' });
    expect(await find(owner, id)).toMatchObject({ billing: 'per_sesi', price: 150_000, outstanding: 150_000 });
    expect(await find(finance, id)).toMatchObject({ outstanding: 150_000 });
    expect(await find(admin, id)).toMatchObject({ outstanding: null });
    expect(await find(t1, id)).toMatchObject({ outstanding: null });

    const paid = await finance.post('/api/payments', { patientId, amount: 50_000, method: 'tunai', paidOn: TODAY, appointmentId: id });
    expect(paid.statusCode).toBe(201);
    expect(await find(owner, id)).toMatchObject({ outstanding: 100_000 });
    await finance.post('/api/payments', { patientId, amount: 100_000, method: 'tunai', paidOn: TODAY, appointmentId: id });
    expect(await find(owner, id)).toMatchObject({ outstanding: 0 });
  });

  it('paket: sisa harga paket yang belum lunas; tanpa biaya dan jadwal batal tidak ditagih', async () => {
    const patientId = await createPatient(env.adminPool, A.orgId, 'Tagih2');
    await finance.post('/api/payments', { patientId, amount: 400_000, method: 'tunai', paidOn: TODAY, newPackage: { packageTypeId: A.packageTypeId } });
    const [pkg] = json(await owner.get(`/api/patients/${patientId}/packages`));
    const id = await schedule(admin, { patientId, time: '15:00', billing: 'paket', patientPackageId: pkg.id });
    expect(await find(owner, id)).toMatchObject({ billing: 'paket', patientPackageId: pkg.id, outstanding: 600_000 });

    const free = await schedule(admin, { patientId, time: '16:00', billing: 'tanpa_biaya' });
    expect(await find(owner, free)).toMatchObject({ outstanding: null });
    await admin.post(`/api/appointments/${id}/cancel`, { reason: 'DEMO batal' });
    expect(await find(owner, id)).toMatchObject({ status: 'dibatalkan', outstanding: null });
  });
});
