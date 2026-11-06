import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importRekap, type RekapInput } from '../src/lib/impor-rekap.ts';
import { buildTenant, json, localDate, login, setupEnv, type Agent, type Tenant, type TestEnv } from './helpers.ts';

// Impor rekap absensi lama (keputusan owner 6 Nov 2026). Semua data uji adalah data DEMO.
let env: TestEnv;
let A: Tenant;
let owner: Agent;
let pkgId: string;
const MONTH = localDate(0).slice(0, 7);

const count = async (sql: string, params: unknown[]) => Number((await env.adminPool.query(sql, params)).rows[0].n);
const input = (): RekapInput => ({
  orgId: A.orgId,
  actorMemberId: A.owner.memberId,
  newPatients: [{ key: 'baru1', fullName: 'DEMO Anak Impor', nickname: 'Impor', programServiceIds: [A.serviceId] }],
  sessions: [
    { ref: 'r2', patientKey: 'baru1', therapistMemberId: A.therapist.memberId, serviceId: A.serviceId, date: localDate(-2), time: '09:00', observations: 'DEMO subjektif', activities: 'DEMO aktivitas', homeProgram: 'DEMO PR' },
    { ref: 'r3', patientId: A.patientId, therapistMemberId: A.therapist.memberId, serviceId: A.serviceId, date: localDate(-1), time: '10:30', activities: 'DEMO aktivitas 2' },
    { ref: 'r4', patientId: A.patientId, therapistMemberId: A.therapist.memberId, serviceId: A.serviceId, date: localDate(-3), time: '15:00' },
  ],
  dailyAllowance: { memberIds: [A.therapist.memberId, A.therapist2.memberId], name: 'Tunjangan Operasional', month: MONTH },
});

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  owner = await login(env.app, A.owner.email);
  // Honor tetap per sesi dan tunjangan operasional bulanan, seperti di klinik.
  // Berlaku sejak lebih dari sebulan lalu agar sesi beberapa hari lalu selalu tercakup.
  const scheme = await owner.put(`/api/compensation/schemes/${A.therapist.memberId}`, {
    effectiveMonth: localDate(-40).slice(0, 7),
    baseSalary: 1_500_000,
    allowances: [{ name: 'Tunjangan Operasional', amount: 10_000 }],
    perSession: { scheme: 'tetap_per_sesi', amount: 10_000 },
  });
  expect(scheme.statusCode).toBe(200);
  pkgId = json(await owner.post(`/api/patients/${A.patientId}/packages`, { packageTypeId: A.packageTypeId })).id;
});
afterAll(() => env.close());

describe('Impor rekap absensi', () => {
  it('uji coba: ringkasan lengkap tetapi tidak ada yang tersimpan', async () => {
    const before = await count(`SELECT count(*) AS n FROM appointments WHERE organization_id = $1`, [A.orgId]);
    const r = await importRekap(env.appPool, input(), { commit: false });
    expect(r.committed).toBe(false);
    expect(r.patients).toHaveLength(1);
    expect(r.sessions.map((s) => s.result)).toEqual(['dimasukkan', 'dimasukkan', 'dimasukkan']);
    expect(await count(`SELECT count(*) AS n FROM appointments WHERE organization_id = $1`, [A.orgId])).toBe(before);
    expect(await count(`SELECT count(*) AS n FROM patients WHERE organization_id = $1 AND full_name = 'DEMO Anak Impor'`, [A.orgId])).toBe(0);
  });

  it('disimpan: pasien baru, sesi selesai tanpa biaya, catatan atas nama terapis, honor, tunjangan harian', async () => {
    const r = await importRekap(env.appPool, input(), { commit: true });
    expect(r.patients[0]).toMatchObject({ key: 'baru1', existed: false });
    expect(r.patients[0].patientCode).toMatch(/-\d{4}$/);
    expect(r.sessions.map((s) => [s.result, s.noteWritten, s.compensation])).toEqual([
      ['dimasukkan', true, 10_000],
      ['dimasukkan', true, 10_000],
      ['dimasukkan', false, 10_000],
    ]);
    expect(r.allowances).toEqual([
      { memberId: A.therapist.memberId, result: 'diubah' },
      { memberId: A.therapist2.memberId, result: 'tidak ditemukan' },
    ]);

    const { rows: appts } = await env.adminPool.query(
      `SELECT status, billing, price, admin_notes FROM appointments WHERE organization_id = $1 AND therapist_member_id = $2`,
      [A.orgId, A.therapist.memberId],
    );
    expect(appts).toHaveLength(3);
    for (const a of appts) expect(a).toMatchObject({ status: 'selesai', billing: 'tanpa_biaya', price: 0 });
    // Paket pasien tidak terpotong (sisa per hari ini dicatat terpisah).
    expect((await env.adminPool.query(`SELECT sessions_used FROM patient_packages WHERE id = $1`, [pkgId])).rows[0].sessions_used).toBe(0);
    // Tidak menjadi tagihan per sesi.
    expect(json(await owner.get('/api/finance/outstanding')).sessions).toEqual([]);

    // Terapis melihat pasien baru & catatannya sendiri (tertaut otomatis); catatan final tampil di dasbor orang tua.
    const t = await login(env.app, A.therapist.email);
    const newId = (await env.adminPool.query(`SELECT id FROM patients WHERE organization_id = $1 AND full_name = 'DEMO Anak Impor'`, [A.orgId])).rows[0].id;
    expect((await t.get(`/api/patients/${newId}`)).statusCode).toBe(200);
    const { rows: notes } = await env.adminPool.query(`SELECT author_member_id, status, observations, activities, home_program FROM therapy_notes WHERE patient_id = $1`, [newId]);
    expect(notes).toEqual([{ author_member_id: A.therapist.memberId, status: 'final', observations: 'DEMO subjektif', activities: 'DEMO aktivitas', home_program: 'DEMO PR' }]);
    const intake = await env.adminPool.query(`SELECT program_service_ids FROM patient_intakes WHERE patient_id = $1`, [newId]);
    expect(intake.rows[0].program_service_ids).toEqual([A.serviceId]);

    // Tunjangan operasional kini per hari hadir: tanggal berbeda di bulan ini x Rp10.000.
    const monthly = json(await owner.get(`/api/compensation/monthly?month=${MONTH}`)).therapists.find((x: any) => x.memberId === A.therapist.memberId);
    const ops = monthly.fixed.find((f: any) => f.name === 'Tunjangan Operasional');
    const days = [-1, -2, -3].filter((d) => localDate(d).slice(0, 7) === MONTH).length;
    expect(ops).toMatchObject({ basis: 'harian', days, amount: days * 10_000 });

    const { rows: audits } = await env.adminPool.query(
      `SELECT action, count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND meta->>'lewat' = 'impor_rekap' GROUP BY action ORDER BY action`,
      [A.orgId],
    );
    expect(audits).toEqual([
      { action: 'catatan.dibuat', n: 2 },
      { action: 'kompensasi.skema_diatur', n: 1 },
      { action: 'pasien.dibuat', n: 1 },
      { action: 'sesi.diabsen', n: 3 },
    ]);
  });

  it('diulang: tidak ada pasien atau sesi ganda', async () => {
    const r = await importRekap(env.appPool, input(), { commit: true });
    expect(r.patients[0].existed).toBe(true);
    expect(r.sessions.map((s) => s.result)).toEqual(['sudah ada', 'sudah ada', 'sudah ada']);
    expect(r.allowances[0].result).toBe('sudah harian');
    expect(await count(`SELECT count(*) AS n FROM patients WHERE organization_id = $1 AND full_name = 'DEMO Anak Impor'`, [A.orgId])).toBe(1);
  });

  it('hanya atas nama owner; kesalahan satu baris membatalkan semuanya', async () => {
    await expect(importRekap(env.appPool, { ...input(), actorMemberId: A.admin.memberId }, { commit: true })).rejects.toThrow(/owner/);
    const bad: RekapInput = {
      orgId: A.orgId,
      actorMemberId: A.owner.memberId,
      newPatients: [{ key: 'baru2', fullName: 'DEMO Anak Gagal' }],
      sessions: [{ ref: 'x1', patientKey: 'tidak-ada', therapistMemberId: A.therapist.memberId, serviceId: A.serviceId, date: localDate(-1), time: '08:00' }],
    };
    await expect(importRekap(env.appPool, bad, { commit: true })).rejects.toThrow(/x1/);
    expect(await count(`SELECT count(*) AS n FROM patients WHERE organization_id = $1 AND full_name = 'DEMO Anak Gagal'`, [A.orgId])).toBe(0);
  });
});
