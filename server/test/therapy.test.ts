import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTenant, json, localDate, login, setupEnv, type Agent, type Tenant, type TestEnv } from './helpers.ts';

let env: TestEnv;
let A: Tenant;
let owner: Agent;
let admin: Agent;
let therapist: Agent;
let therapist2: Agent;
let finance: Agent;

async function schedule(body: Record<string, unknown>) {
  const res = await owner.post('/api/appointments', {
    patientId: A.patientId,
    therapistMemberId: A.therapist.memberId,
    serviceId: A.serviceId,
    date: localDate(0),
    billing: 'per_sesi',
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  return json(res).ids[0] as string;
}

let hour = 6;
const nextTime = () => `${String(hour++).padStart(2, '0')}:00`;

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  owner = await login(env.app, A.owner.email);
  admin = await login(env.app, A.admin.email);
  therapist = await login(env.app, A.therapist.email);
  therapist2 = await login(env.app, A.therapist2.email);
  finance = await login(env.app, A.finance.email);
});
afterAll(() => env.close());

describe('Akses klinis berbasis peran & penugasan', () => {
  it('terapis hanya melihat pasien yang ditugaskan kepadanya', async () => {
    const list = json(await therapist.get('/api/patients'));
    expect(list.items.map((p: any) => p.id)).toEqual([A.patientId]);
    expect((await therapist.get(`/api/patients/${A.patient2Id}`)).statusCode).toBe(404);
    expect((await therapist2.get(`/api/patients/${A.patientId}`)).statusCode).toBe(404);
  });

  it('terapis tidak dapat menulis catatan untuk pasien yang tidak ditugaskan', async () => {
    const res = await therapist.post('/api/notes', { patientId: A.patient2Id, observations: 'DEMO' });
    expect(res.statusCode).toBe(404);
  });

  it('admin dan keuangan tidak dapat membaca catatan klinis (API 403, database 0 baris)', async () => {
    const note = json(await therapist.post('/api/notes', { patientId: A.patientId, noteType: 'asesmen', observations: 'DEMO asesmen awal' }));
    for (const agent of [admin, finance]) {
      expect((await agent.get(`/api/notes/${note.id}`)).statusCode).toBe(403);
      expect((await agent.get(`/api/patients/${A.patientId}/notes`)).statusCode).toBe(403);
    }
    // Lapisan database: konteks admin (scope catatan = none) tidak melihat catatan.
    const { withTx } = await import('../src/db.ts');
    const n = await withTx(
      env.appPool,
      {
        settings: {
          'app.mode': 'tenant',
          'app.org_id': A.orgId,
          'app.member_id': A.admin.memberId,
          'app.scope_patient': 'all',
          'app.scope_note': 'none',
        },
      },
      async (db) => (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM therapy_notes`)).n,
    );
    expect(n).toBe(0);
    // Owner dapat membaca.
    expect((await owner.get(`/api/notes/${note.id}`)).statusCode).toBe(200);
  });

  it('terapis tidak memiliki akses keuangan', async () => {
    expect((await therapist.get(`/api/payments?from=${localDate(-1)}&to=${localDate(0)}`)).statusCode).toBe(403);
    expect((await therapist.get(`/api/patients/${A.patientId}/payments`)).statusCode).toBe(403);
    expect((await therapist.get(`/api/reports/finance?from=${localDate(-1)}&to=${localDate(0)}`)).statusCode).toBe(403);
  });

  it('terapis hanya melihat jadwalnya sendiri dan hanya dapat menyelesaikan sesinya sendiri', async () => {
    const mine = await schedule({ time: nextTime() });
    await env.adminPool.query(`INSERT INTO patient_therapists (organization_id, patient_id, member_id) VALUES ($1, $2, $3)`, [
      A.orgId,
      A.patient2Id,
      A.therapist2.memberId,
    ]);
    const other = await schedule({ patientId: A.patient2Id, therapistMemberId: A.therapist2.memberId, time: nextTime() });
    const list = json<any[]>(await therapist.get(`/api/appointments?from=${localDate(0)}&to=${localDate(0)}`));
    expect(list.some((a) => a.id === mine)).toBe(true);
    expect(list.some((a) => a.id === other)).toBe(false);
    expect((await therapist.post(`/api/appointments/${other}/complete`)).statusCode).toBe(404);
    expect((await therapist.post(`/api/appointments/${mine}/complete`)).statusCode).toBe(200);
  });
});

describe('Catatan terapi: riwayat & kebijakan perubahan', () => {
  it('hanya penulis yang dapat mengubah catatan; owner hanya membaca', async () => {
    const appt = await schedule({ time: nextTime() });
    const note = json(await therapist.post('/api/notes', { patientId: A.patientId, appointmentId: appt, objectives: 'DEMO tujuan' }));
    const byOwner = await owner.put(`/api/notes/${note.id}`, { objectives: 'diubah owner' });
    expect(byOwner.statusCode).toBe(403);
  });

  it('setiap perubahan menyimpan revisi; catatan final hanya dapat dikoreksi dengan alasan', async () => {
    const appt = await schedule({ time: nextTime() });
    const note = json(await therapist.post('/api/notes', { patientId: A.patientId, appointmentId: appt, observations: 'DEMO v1' }));
    expect(json(await therapist.put(`/api/notes/${note.id}`, { observations: 'DEMO v2', finalize: true })).revisionNo).toBe(2);
    const noReason = await therapist.put(`/api/notes/${note.id}`, { observations: 'DEMO v3' });
    expect(noReason.statusCode).toBe(400);
    const withReason = await therapist.put(`/api/notes/${note.id}`, { observations: 'DEMO v3', reason: 'Koreksi salah ketik' });
    expect(json(withReason).revisionNo).toBe(3);

    const revisions = json<any[]>(await therapist.get(`/api/notes/${note.id}/revisions`));
    expect(revisions.map((r) => r.content.observations)).toEqual(['DEMO v3', 'DEMO v2', 'DEMO v1']);
    expect(revisions[0].reason).toBe('Koreksi salah ketik');
    expect(json(await therapist.get(`/api/notes/${note.id}`)).status).toBe('final');
    // Hemat ruang: versi terkini hanya disimpan di therapy_notes; tabel revisi berisi 2 versi lama saja.
    const { rows } = await env.adminPool.query(`SELECT count(*)::int AS n FROM therapy_note_revisions WHERE note_id = $1`, [note.id]);
    expect(rows[0].n).toBe(2);
  });

  it('satu catatan per sesi; tidak ada endpoint penghapusan catatan', async () => {
    const appt = await schedule({ time: nextTime() });
    expect((await therapist.post('/api/notes', { patientId: A.patientId, appointmentId: appt, observations: 'DEMO' })).statusCode).toBe(201);
    expect((await therapist.post('/api/notes', { patientId: A.patientId, appointmentId: appt, observations: 'DEMO' })).statusCode).toBe(409);
    const { rows } = await env.adminPool.query(`SELECT id FROM therapy_notes WHERE appointment_id = $1`, [appt]);
    expect((await therapist.delete(`/api/notes/${rows[0].id}`)).statusCode).toBe(404);
  });

  it('audit catatan tidak menyimpan isi klinis', async () => {
    const { rows } = await env.adminPool.query(
      `SELECT meta::text AS meta FROM audit_logs WHERE organization_id = $1 AND action LIKE 'catatan.%'`,
      [A.orgId],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.meta).not.toContain('DEMO v');
  });
});

describe('Integritas sesi', () => {
  it('sesi yang gagal diselesaikan (saldo paket habis) tidak meninggalkan data parsial', async () => {
    const pkg = json(await owner.post(`/api/patients/${A.patientId}/packages`, { packageTypeId: A.packageTypeId }));
    await env.adminPool.query(`UPDATE patient_packages SET sessions_used = sessions_total, status = 'aktif' WHERE id = $1`, [pkg.id]);
    // Paket penuh: buat jadwal langsung di DB (validasi API mengizinkan paket aktif).
    const appt = await schedule({ time: nextTime(), billing: 'paket', patientPackageId: pkg.id });
    await env.adminPool.query(
      `INSERT INTO compensation_rules (organization_id, member_id, scheme, amount, effective_from) VALUES ($1, $2, 'tetap_per_sesi', 50000, '2020-01-01')`,
      [A.orgId, A.therapist.memberId],
    );
    const res = await therapist.post(`/api/appointments/${appt}/complete`);
    expect(res.statusCode).toBe(409);
    const { rows } = await env.adminPool.query(
      `SELECT a.status,
              (SELECT count(*)::int FROM package_ledger WHERE appointment_id = a.id) AS ledger,
              (SELECT count(*)::int FROM therapist_compensations WHERE appointment_id = a.id) AS comp
         FROM appointments a WHERE a.id = $1`,
      [appt],
    );
    expect(rows[0]).toEqual({ status: 'terjadwal', ledger: 0, comp: 0 });
  });

  it('sesi selesai menghitung kompensasi sesuai aturan; koreksi membatalkan kompensasi & mengembalikan saldo', async () => {
    const pkg = json(await owner.post(`/api/patients/${A.patientId}/packages`, { packageTypeId: A.packageTypeId }));
    const appt = await schedule({ time: nextTime(), billing: 'paket', patientPackageId: pkg.id });
    expect(json(await therapist.post(`/api/appointments/${appt}/complete`)).sessionsRemaining).toBe(7);
    const comp = await env.adminPool.query(`SELECT amount, status, basis FROM therapist_compensations WHERE appointment_id = $1`, [appt]);
    expect(comp.rows[0].amount).toBe(50000);
    expect(comp.rows[0].basis.skema).toBe('tetap_per_sesi');

    expect((await admin.post(`/api/appointments/${appt}/reopen`, { reason: 'salah input' })).statusCode).toBe(403);
    expect((await owner.post(`/api/appointments/${appt}/reopen`, { reason: 'Salah pilih pasien' })).statusCode).toBe(200);
    const after = await env.adminPool.query(
      `SELECT (SELECT sessions_used FROM patient_packages WHERE id = $1) AS used,
              (SELECT status FROM therapist_compensations WHERE appointment_id = $2) AS comp_status,
              (SELECT array_agg(kind ORDER BY created_at) FROM package_ledger WHERE patient_package_id = $1) AS kinds`,
      [pkg.id, appt],
    );
    expect(after.rows[0]).toEqual({ used: 0, comp_status: 'dibatalkan', kinds: ['pemakaian', 'pembatalan_pemakaian'] });
  });

  it('ketidakhadiran tidak memotong saldo paket (kebijakan default)', async () => {
    const pkg = json(await owner.post(`/api/patients/${A.patientId}/packages`, { packageTypeId: A.packageTypeId }));
    const appt = await schedule({ time: nextTime(), billing: 'paket', patientPackageId: pkg.id });
    expect((await therapist.post(`/api/appointments/${appt}/no-show`)).statusCode).toBe(200);
    const { rows } = await env.adminPool.query(`SELECT sessions_used FROM patient_packages WHERE id = $1`, [pkg.id]);
    expect(rows[0].sessions_used).toBe(0);
  });

  it('jadwal bentrok untuk terapis yang sama ditolak; jadwal ulang menyimpan jejak', async () => {
    const time = nextTime();
    const first = await schedule({ time });
    const clash = await owner.post('/api/appointments', {
      patientId: A.patient2Id,
      therapistMemberId: A.therapist.memberId,
      date: localDate(0),
      time,
      billing: 'tanpa_biaya',
    });
    expect(clash.statusCode).toBe(409);
    const moved = json(await owner.post(`/api/appointments/${first}/reschedule`, { date: localDate(2), time: '10:00' }));
    const { rows } = await env.adminPool.query(`SELECT status, (SELECT rescheduled_from_id FROM appointments WHERE id = $2) AS from_id FROM appointments WHERE id = $1`, [
      first,
      moved.id,
    ]);
    expect(rows[0]).toEqual({ status: 'dijadwal_ulang', from_id: first });
  });

  it('sesi hari mendatang belum dapat diselesaikan', async () => {
    const appt = await schedule({ date: localDate(3), time: '07:00' });
    expect((await therapist.post(`/api/appointments/${appt}/complete`)).statusCode).toBe(400);
  });
});
