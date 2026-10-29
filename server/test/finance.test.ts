import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTenant, json, localDate, login, setupEnv, unzipAll, type Agent, type Tenant, type TestEnv } from './helpers.ts';

let env: TestEnv;
let A: Tenant;
let owner: Agent;
let admin: Agent;
let finance: Agent;

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  owner = await login(env.app, A.owner.email);
  admin = await login(env.app, A.admin.email);
  finance = await login(env.app, A.finance.email);
});
afterAll(() => env.close());

describe('Paket & saldo sesi', () => {
  it('penyelesaian bersamaan tidak membuat saldo paket minus (hanya satu yang berhasil)', async () => {
    const pkg = json(await owner.post(`/api/patients/${A.patientId}/packages`, { packageTypeId: A.packageTypeId }));
    await env.adminPool.query(`UPDATE patient_packages SET sessions_used = sessions_total - 1 WHERE id = $1`, [pkg.id]);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await owner.post('/api/appointments', {
        patientId: A.patientId,
        therapistMemberId: A.therapist.memberId,
        date: localDate(-1),
        time: `${String(8 + i).padStart(2, '0')}:00`,
        billing: 'paket',
        patientPackageId: pkg.id,
      });
      expect(r.statusCode, r.body).toBe(201);
      ids.push(json(r).ids[0]);
    }
    const results = await Promise.all(ids.map((id) => owner.post(`/api/appointments/${id}/complete`)));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409, 409]);
    const { rows } = await env.adminPool.query(
      `SELECT sessions_used, sessions_total, status, (SELECT count(*)::int FROM package_ledger WHERE patient_package_id = $1) AS ledger
         FROM patient_packages WHERE id = $1`,
      [pkg.id],
    );
    expect(rows[0].sessions_used).toBe(rows[0].sessions_total);
    expect(rows[0].status).toBe('selesai');
    expect(rows[0].ledger).toBe(1);
  });

  it('permintaan penyelesaian ganda untuk sesi yang sama hanya diproses sekali', async () => {
    const pkg = json(await owner.post(`/api/patients/${A.patientId}/packages`, { packageTypeId: A.packageTypeId }));
    const r = json(
      await owner.post('/api/appointments', {
        patientId: A.patientId,
        therapistMemberId: A.therapist.memberId,
        date: localDate(-2),
        time: '15:00',
        billing: 'paket',
        patientPackageId: pkg.id,
      }),
    );
    const results = await Promise.all([1, 2, 3].map(() => owner.post(`/api/appointments/${r.ids[0]}/complete`)));
    expect(results.filter((x) => x.statusCode === 200)).toHaveLength(1);
    const { rows } = await env.adminPool.query(`SELECT sessions_used FROM patient_packages WHERE id = $1`, [pkg.id]);
    expect(rows[0].sessions_used).toBe(1);
  });

  it('penyesuaian saldo memerlukan izin owner dan tidak dapat keluar batas', async () => {
    const pkg = json(await owner.post(`/api/patients/${A.patientId}/packages`, { packageTypeId: A.packageTypeId }));
    expect((await finance.post(`/api/patient-packages/${pkg.id}/adjust`, { sessionsDelta: 1, reason: 'koreksi data awal' })).statusCode).toBe(403);
    expect((await owner.post(`/api/patient-packages/${pkg.id}/adjust`, { sessionsDelta: -1, reason: 'koreksi data awal' })).statusCode).toBe(409);
    const ok = json(await owner.post(`/api/patient-packages/${pkg.id}/adjust`, { sessionsDelta: 3, reason: 'Sesi lama sebelum sistem' }));
    expect(ok.sessionsRemaining).toBe(5);
    const detail = json(await owner.get(`/api/patient-packages/${pkg.id}`));
    expect(detail.ledger.map((l: any) => [l.kind, l.sessionsDelta])).toEqual([['penyesuaian', 3]]);
  });
});

describe('Pembayaran & keuangan', () => {
  it('nomor kuitansi berurutan per organisasi; QRIS dicatat sebagai metode manual', async () => {
    const a = json(await finance.post('/api/payments', { patientId: A.patientId, amount: 150000, method: 'qris', paidOn: '2026-10-01' }));
    const b = json(await finance.post('/api/payments', { patientId: A.patientId, amount: 150000, method: 'tunai', paidOn: '2026-10-01' }));
    const n = (s: string) => Number(s.split('/').pop());
    expect(a.receiptNo).toMatch(/^KW\/2026\/\d{5}$/);
    expect(n(b.receiptNo)).toBe(n(a.receiptNo) + 1);
  });

  it('pembayaran tidak dapat diedit; pembatalan hanya oleh owner dengan alasan', async () => {
    const p = json(await finance.post('/api/payments', { patientId: A.patientId, amount: 20000, method: 'tunai', paidOn: localDate(0) }));
    expect((await finance.post(`/api/payments/${p.id}/void`, { reason: 'salah input' })).statusCode).toBe(403);
    expect((await owner.post(`/api/payments/${p.id}/void`, { reason: '' })).statusCode).toBe(400);
    expect((await owner.post(`/api/payments/${p.id}/void`, { reason: 'Salah input nominal' })).statusCode).toBe(200);
    expect((await owner.post(`/api/payments/${p.id}/void`, { reason: 'Salah input nominal' })).statusCode).toBe(409);
    expect((await owner.patch(`/api/payments/${p.id}`, { amount: 1 })).statusCode).toBe(404);
  });

  it('admin tidak memiliki akses keuangan secara default', async () => {
    expect((await admin.get(`/api/payments?from=${localDate(-1)}&to=${localDate(0)}`)).statusCode).toBe(403);
    expect((await admin.post('/api/payments', { patientId: A.patientId, amount: 1000, method: 'tunai', paidOn: localDate(0) })).statusCode).toBe(403);
  });

  it('pembayaran per-sesi hanya untuk sesi bertagihan per sesi dan piutang dihitung benar', async () => {
    const r = json(
      await owner.post('/api/appointments', {
        patientId: A.patient2Id,
        therapistMemberId: A.therapist2.memberId,
        serviceId: A.serviceId,
        date: localDate(-1),
        time: '07:00',
        billing: 'per_sesi',
      }),
    );
    await owner.post(`/api/appointments/${r.ids[0]}/complete`);
    let out = json(await finance.get('/api/finance/outstanding'));
    expect(out.sessions.find((s: any) => s.appointmentId === r.ids[0]).outstanding).toBe(150000);
    await finance.post('/api/payments', { patientId: A.patient2Id, amount: 100000, method: 'transfer', paidOn: localDate(0), appointmentId: r.ids[0] });
    out = json(await finance.get('/api/finance/outstanding'));
    expect(out.sessions.find((s: any) => s.appointmentId === r.ids[0]).outstanding).toBe(50000);
    // Sesi milik pasien lain tidak dapat dibayar atas nama pasien ini.
    const wrong = await finance.post('/api/payments', { patientId: A.patientId, amount: 50000, method: 'tunai', paidOn: localDate(0), appointmentId: r.ids[0] });
    expect(wrong.statusCode).toBe(400);
  });

  it('laporan keuangan memakai basis kas, mencantumkan definisi, dan tidak menyebut laba', async () => {
    const rep = json(await owner.get(`/api/reports/finance?from=2026-01-01&to=2026-12-31`));
    expect(rep.definitions.selisih_kas).toMatch(/BUKAN laba/);
    expect(rep.definitions.qris).toMatch(/manual/);
    expect(JSON.stringify(Object.keys(rep))).not.toMatch(/profit|laba/i);
    expect(rep.cashDifference).toBe(rep.payments.total - rep.expenses.total);
  });

  it('ekspor Excel adalah XLSX valid dan tercatat di audit', async () => {
    const res = await finance.get(`/api/reports/keuangan/export?from=2026-01-01&to=2026-12-31`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const xml = unzipAll(res.rawPayload);
    expect(xml).toContain('<workbook');
    expect(xml).toContain('Pembayaran');
    expect(xml).toContain('qris (manual)');
    const { rows } = await env.adminPool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND action = 'laporan.diekspor'`, [A.orgId]);
    expect(rows[0].n).toBeGreaterThan(0);
    // Ekspor operasional tidak tersedia untuk peran keuangan.
    expect((await finance.get(`/api/reports/operasional/export?from=2026-01-01&to=2026-12-31`)).statusCode).toBe(403);
  });
});

describe('Kompensasi terapis', () => {
  it('skema per terapis: nominal tetap vs persentase tarif; terapis hanya melihat miliknya', async () => {
    await owner.post('/api/compensation/rules', { memberId: A.therapist2.memberId, scheme: 'persen_tarif', percent: 40, effectiveFrom: '2020-01-01' });
    const overlap = await owner.post('/api/compensation/rules', { memberId: A.therapist2.memberId, scheme: 'persen_tarif', percent: 50, effectiveFrom: '2021-01-01' });
    expect(overlap.statusCode).toBe(409);
    const r = json(
      await owner.post('/api/appointments', {
        patientId: A.patient2Id,
        therapistMemberId: A.therapist2.memberId,
        serviceId: A.serviceId,
        date: localDate(-1),
        time: '18:00',
        billing: 'per_sesi',
        price: 200000,
      }),
    );
    await owner.post(`/api/appointments/${r.ids[0]}/complete`);
    const { rows } = await env.adminPool.query(`SELECT amount FROM therapist_compensations WHERE appointment_id = $1`, [r.ids[0]]);
    expect(rows[0].amount).toBe(80000);

    const t2 = await login(env.app, A.therapist2.email);
    const mine = json(await t2.get(`/api/compensation?from=${localDate(-30)}&to=${localDate(0)}`));
    expect(mine.items.every((i: any) => i.memberId === A.therapist2.memberId)).toBe(true);
    const t1 = await login(env.app, A.therapist.email);
    const other = json(await t1.get(`/api/compensation?from=${localDate(-30)}&to=${localDate(0)}`));
    expect(other.items.some((i: any) => i.memberId === A.therapist2.memberId)).toBe(false);
    expect((await t1.post('/api/compensation/mark-paid', { ids: [mine.items[0].id], paidOn: localDate(0) })).statusCode).toBe(403);
    expect(json(await owner.post('/api/compensation/mark-paid', { ids: [mine.items[0].id], paidOn: localDate(0) })).updated).toBe(1);
  });
});
