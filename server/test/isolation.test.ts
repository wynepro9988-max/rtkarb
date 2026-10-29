import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTenant, json, localDate, login, setupEnv, unzipAll, type Agent, type Tenant, type TestEnv } from './helpers.ts';

let env: TestEnv;
let A: Tenant;
let B: Tenant;
let ownerA: Agent;
let ownerB: Agent;

// Objek milik B yang akan dicoba diakses dari A.
const bObjects: Record<string, string> = {};

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  B = await buildTenant(env.adminPool, 'B');
  ownerA = await login(env.app, A.owner.email);
  ownerB = await login(env.app, B.owner.email);

  // Bangun data B melalui API sebagai owner B.
  const pkg = json(await ownerB.post(`/api/patients/${B.patientId}/packages`, { packageTypeId: B.packageTypeId }));
  bObjects.package = pkg.id;
  const appt = json(
    await ownerB.post('/api/appointments', {
      patientId: B.patientId,
      therapistMemberId: B.therapist.memberId,
      serviceId: B.serviceId,
      date: localDate(0),
      time: '08:00',
      billing: 'paket',
      patientPackageId: pkg.id,
    }),
  );
  bObjects.appointment = appt.ids[0];
  const therapistB = await login(env.app, B.therapist.email);
  expect((await therapistB.post(`/api/appointments/${bObjects.appointment}/complete`)).statusCode).toBe(200);
  const note = json(
    await therapistB.post('/api/notes', {
      patientId: B.patientId,
      appointmentId: bObjects.appointment,
      observations: 'DEMO observasi rahasia B',
      finalize: true,
    }),
  );
  bObjects.note = note.id;
  const pay = json(
    await ownerB.post('/api/payments', { patientId: B.patientId, amount: 1000000, method: 'transfer', paidOn: localDate(0), patientPackageId: pkg.id }),
  );
  bObjects.payment = pay.id;
  const g = await env.adminPool.query<{ id: string }>(`SELECT id FROM guardians WHERE patient_id = $1`, [B.patientId]);
  bObjects.guardian = g.rows[0].id;
  const exp = json(
    await ownerB.post('/api/expenses', { spentOn: localDate(0), category: 'Operasional', description: 'DEMO biaya B', amount: 77777, method: 'tunai' }),
  );
  bObjects.expense = exp.id;
});
afterAll(() => env.close());

describe('Isolasi data antar-organisasi melalui API', () => {
  it('A tidak dapat membaca objek B berdasarkan ID (selalu 404, sama seperti data yang tidak ada)', async () => {
    const paths = [
      `/api/patients/${B.patientId}`,
      `/api/patients/${B.patientId}/appointments`,
      `/api/patients/${B.patientId}/notes`,
      `/api/patients/${B.patientId}/packages`,
      `/api/patients/${B.patientId}/payments`,
      `/api/patients/${B.patientId}/documents`,
      `/api/appointments/${bObjects.appointment}`,
      `/api/notes/${bObjects.note}`,
      `/api/notes/${bObjects.note}/revisions`,
      `/api/patient-packages/${bObjects.package}`,
      `/api/payments/${bObjects.payment}`,
    ];
    for (const p of paths) {
      const res = await ownerA.get(p);
      expect(res.statusCode, p).toBe(404);
      expect(res.body).not.toContain('DEMO observasi rahasia B');
    }
    // Respons untuk ID B identik dengan ID acak yang tidak ada.
    const random = await ownerA.get(`/api/patients/00000000-0000-4000-8000-000000000000`);
    expect(json(random)).toEqual(json(await ownerA.get(`/api/patients/${B.patientId}`)));
  });

  it('A tidak dapat menemukan pasien B lewat pencarian maupun daftar', async () => {
    const all = json(await ownerA.get('/api/patients?limit=200'));
    expect(all.items.some((p: any) => p.id === B.patientId || p.id === B.patient2Id)).toBe(false);
    const search = json(await ownerA.get(`/api/patients?q=${encodeURIComponent('DEMO Anak B')}`));
    expect(search.total).toBe(0);
  });

  it('A tidak dapat mengubah, membatalkan, atau menghapus data B', async () => {
    const attempts: [string, string, unknown?][] = [
      ['PATCH', `/api/patients/${B.patientId}`, { fullName: 'DEMO Diambil Alih' }],
      ['PATCH', `/api/guardians/${bObjects.guardian}`, { phone: '0811' }],
      ['DELETE', `/api/guardians/${bObjects.guardian}`],
      ['PUT', `/api/patients/${B.patientId}/therapists`, { memberIds: [] }],
      ['POST', `/api/appointments/${bObjects.appointment}/reopen`, { reason: 'coba ambil alih' }],
      ['POST', `/api/appointments/${bObjects.appointment}/cancel`, { reason: 'coba' }],
      ['PUT', `/api/notes/${bObjects.note}`, { observations: 'ditimpa', reason: 'coba timpa' }],
      ['POST', `/api/payments/${bObjects.payment}/void`, { reason: 'coba batal' }],
      ['POST', `/api/expenses/${bObjects.expense}/void`, { reason: 'coba batal' }],
      ['POST', `/api/patient-packages/${bObjects.package}/adjust`, { sessionsDelta: -1, reason: 'coba tambah saldo' }],
      ['POST', `/api/patient-packages/${bObjects.package}/cancel`, { reason: 'coba batal' }],
      ['POST', `/api/patients/${B.patientId}/packages`, { packageTypeId: B.packageTypeId }],
    ];
    for (const [method, url, body] of attempts) {
      const res = await ownerA.request(method as 'POST', url, body);
      expect([400, 404], `${method} ${url} -> ${res.statusCode}`).toContain(res.statusCode);
    }
    const { rows } = await env.adminPool.query(
      `SELECT p.full_name, pay.status AS pay_status, pp.sessions_used, n.observations
         FROM patients p, payments pay, patient_packages pp, therapy_notes n
        WHERE p.id = $1 AND pay.id = $2 AND pp.id = $3 AND n.id = $4`,
      [B.patientId, bObjects.payment, bObjects.package, bObjects.note],
    );
    expect(rows[0]).toEqual({ full_name: expect.stringContaining('DEMO Anak B'), pay_status: 'tercatat', sessions_used: 1, observations: 'DEMO observasi rahasia B' });
  });

  it('A tidak dapat menautkan data A ke objek B (pasien, terapis, paket, layanan)', async () => {
    const tries = [
      { patientId: B.patientId, therapistMemberId: A.therapist.memberId, date: localDate(1), time: '09:00', billing: 'per_sesi' },
      { patientId: A.patientId, therapistMemberId: B.therapist.memberId, date: localDate(1), time: '09:00', billing: 'per_sesi' },
      { patientId: A.patientId, therapistMemberId: A.therapist.memberId, serviceId: B.serviceId, date: localDate(1), time: '09:00', billing: 'per_sesi' },
      { patientId: A.patientId, therapistMemberId: A.therapist.memberId, date: localDate(1), time: '09:00', billing: 'paket', patientPackageId: bObjects.package },
    ];
    for (const body of tries) {
      const res = await ownerA.post('/api/appointments', body);
      expect([400, 404]).toContain(res.statusCode);
    }
    expect((await ownerA.post(`/api/patients/${A.patientId}/packages`, { packageTypeId: B.packageTypeId })).statusCode).toBe(400);
    expect(
      (await ownerA.post('/api/payments', { patientId: A.patientId, amount: 1000, method: 'tunai', paidOn: localDate(0), patientPackageId: bObjects.package }))
        .statusCode,
    ).toBe(400);
    expect((await ownerA.put(`/api/patients/${A.patientId}/therapists`, { memberIds: [B.therapist.memberId] })).statusCode).toBe(400);
  });

  it('dashboard, laporan, dan daftar keuangan A tidak memuat data B', async () => {
    const from = localDate(-30);
    const to = localDate(1);
    const dashA = json(await ownerA.get('/api/dashboard'));
    expect(dashA.todayAppointments.some((a: any) => a.id === bObjects.appointment)).toBe(false);
    expect(dashA.payments.month).toBe(0);

    const finA = json(await ownerA.get(`/api/reports/finance?from=${from}&to=${to}`));
    expect(finA.payments.total).toBe(0);
    expect(finA.expenses.total).toBe(0);
    const opsA = json(await ownerA.get(`/api/reports/operational?from=${from}&to=${to}`));
    expect(opsA.sessionsByStatus).toEqual([]);

    const finB = json(await ownerB.get(`/api/reports/finance?from=${from}&to=${to}`));
    expect(finB.payments.total).toBe(1000000);
    expect(finB.expenses.total).toBe(77777);

    const paymentsA = json<any[]>(await ownerA.get(`/api/payments?from=${from}&to=${to}`));
    expect(paymentsA).toEqual([]);
    const outstandingA = json(await ownerA.get('/api/finance/outstanding'));
    expect(outstandingA.packages).toEqual([]);
  });

  it('ekspor Excel A tidak memuat data B', async () => {
    const res = await ownerA.get(`/api/reports/keuangan/export?from=${localDate(-30)}&to=${localDate(1)}`);
    expect(res.statusCode).toBe(200);
    const xml = unzipAll(res.rawPayload);
    expect(xml).not.toContain('DEMO Anak B');
    expect(xml).not.toContain('77777');
    const resB = await ownerB.get(`/api/reports/keuangan/export?from=${localDate(-30)}&to=${localDate(1)}`);
    expect(unzipAll(resB.rawPayload)).toContain('DEMO Anak B');
  });

  it('audit log A tidak memuat aktivitas B', async () => {
    const res = json(await ownerA.get(`/api/audit?from=${localDate(-1)}&to=${localDate(1)}&limit=200`));
    expect(res.items.some((l: any) => l.entity_id === B.patientId || l.entityId === B.patientId)).toBe(false);
    expect(res.items.some((l: any) => l.entityId === bObjects.payment)).toBe(false);
  });

  it('terapis A tidak dapat mengakses apa pun milik B', async () => {
    const t = await login(env.app, A.therapist.email);
    expect((await t.get(`/api/notes/${bObjects.note}`)).statusCode).toBe(404);
    expect((await t.get(`/api/patients/${B.patientId}`)).statusCode).toBe(404);
    expect((await t.post(`/api/appointments/${bObjects.appointment}/no-show`)).statusCode).toBe(404);
    const therapists = json<any[]>(await t.get('/api/staff/therapists'));
    expect(therapists.some((x) => x.id === B.therapist.memberId)).toBe(false);
  });
});
