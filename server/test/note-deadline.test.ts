import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTenant, json, login, setupEnv, unzipAll, type Tenant, type TestEnv } from './helpers.ts';

// Kewajiban catatan: sesi selesai wajib punya catatan final paling lambat akhir bulan sesi.
let env: TestEnv;
let A: Tenant;
let B: Tenant;
let months: { prevStart: string; prevEnd: string; curEnd: string };
const ids: Record<string, string> = {};

const TZ = `(SELECT timezone FROM organizations WHERE id = $1)`;

// Sesi selesai langsung di database: `day` = hari ke-n bulan lalu (prev) atau bulan ini (cur), pukul 09.00 waktu organisasi.
async function doneSession(t: Tenant, month: 'prev' | 'cur', day: number): Promise<string> {
  const base = month === 'prev' ? `date_trunc('month', now() AT TIME ZONE ${TZ}) - interval '1 month'` : `date_trunc('month', now() AT TIME ZONE ${TZ})`;
  const { rows } = await env.adminPool.query<{ id: string }>(
    `INSERT INTO appointments (organization_id, patient_id, therapist_member_id, service_id, starts_at, duration_minutes, status, billing, price, completed_at)
     VALUES ($1, $2, $3, $4, (${base} + make_interval(days => $5 - 1, hours => 9)) AT TIME ZONE ${TZ}, 60, 'selesai', 'per_sesi', 150000, now())
     RETURNING id`,
    [t.orgId, t.patientId, t.therapist.memberId, t.serviceId, day],
  );
  return rows[0].id;
}

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  B = await buildTenant(env.adminPool, 'B');
  const { rows } = await env.adminPool.query(
    `SELECT to_char(date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta') - interval '1 month', 'YYYY-MM-DD') AS prev_start,
            to_char(date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta') - interval '1 day', 'YYYY-MM-DD') AS prev_end,
            to_char(date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta') + interval '1 month - 1 day', 'YYYY-MM-DD') AS cur_end`,
  );
  months = { prevStart: rows[0].prev_start, prevEnd: rows[0].prev_end, curEnd: rows[0].cur_end };

  ids.prevNone = await doneSession(A, 'prev', 10);
  ids.prevLate = await doneSession(A, 'prev', 11);
  ids.prevDraft = await doneSession(A, 'prev', 12);
  ids.curNone = await doneSession(A, 'cur', 1);
  ids.curFinal = await doneSession(A, 'cur', 2);
  ids.bPrevNone = await doneSession(B, 'prev', 10);

  const therapist = await login(env.app, A.therapist.email);
  const note = (appointmentId: string, finalize: boolean) =>
    therapist.post('/api/notes', { patientId: A.patientId, appointmentId, noteType: 'sesi', observations: 'DEMO catatan sesi', finalize });
  // Difinalkan sekarang untuk sesi bulan lalu = final terlambat.
  expect((await note(ids.prevLate, true)).statusCode).toBe(201);
  expect((await note(ids.prevDraft, false)).statusCode).toBe(201);
  expect((await note(ids.curFinal, true)).statusCode).toBe(201);
});
afterAll(() => env.close());

describe('Batas catatan sesi: akhir bulan', () => {
  it('dasbor terapis: daftar belum final terurut dari yang paling lama, dengan batas & tanda lewat batas', async () => {
    const therapist = await login(env.app, A.therapist.email);
    const d = json(await therapist.get('/api/dashboard'));
    expect(d.notesDue).toEqual({ pending: 3, overdue: 2, monthDeadline: months.curEnd });
    expect(d.pendingNotes.map((n: any) => [n.appointmentId, n.overdue, n.deadline])).toEqual([
      [ids.prevNone, true, months.prevEnd],
      [ids.prevDraft, true, months.prevEnd],
      [ids.curNone, false, months.curEnd],
    ]);
    // Terapis lain tidak melihat kewajiban milik terapis A.
    const other = json(await (await login(env.app, A.therapist2.email)).get('/api/dashboard'));
    expect(other.notesDue).toMatchObject({ pending: 0, overdue: 0 });
  });

  it('laporan operasional owner: per terapis menghitung belum final, lewat batas, dan final terlambat', async () => {
    const owner = await login(env.app, A.owner.email);
    const r = json(await owner.get(`/api/reports/operational?from=${months.prevStart}&to=${months.curEnd}`));
    expect({ pending: r.pendingNotes, overdue: r.overdueNotes, late: r.lateNotes }).toEqual({ pending: 3, overdue: 2, late: 1 });
    const row = r.byTherapist.find((t: any) => t.notesPending > 0);
    expect(row).toMatchObject({ completed: 5, notesPending: 3, notesOverdue: 2, notesLate: 1 });

    const xlsx = await owner.get(`/api/reports/operasional/export?from=${months.prevStart}&to=${months.curEnd}`);
    expect(xlsx.statusCode).toBe(200);
    const xml = unzipAll(xlsx.rawPayload);
    for (const label of ['lewat batas', 'final (terlambat)', 'belum ada', 'final']) expect(xml).toContain(label);
  });

  it('admin (tanpa akses catatan) tidak mendapat hitungan kepatuhan yang menyesatkan', async () => {
    const admin = await login(env.app, A.admin.email);
    const r = json(await admin.get(`/api/reports/operational?from=${months.prevStart}&to=${months.curEnd}`));
    expect(r.pendingNotes).toBeNull();
    expect(r.overdueNotes).toBeNull();
    expect(r.byTherapist[0].notesPending).toBeUndefined();
    const xml = unzipAll((await admin.get(`/api/reports/operasional/export?from=${months.prevStart}&to=${months.curEnd}`)).rawPayload);
    expect(xml).not.toContain('lewat batas');
  });

  it('hitungan organisasi A tidak memuat sesi organisasi B', async () => {
    const ownerB = json(await (await login(env.app, B.owner.email)).get('/api/dashboard'));
    expect(ownerB.notesDue).toMatchObject({ pending: 1, overdue: 1 });
    expect(ownerB.pendingNotes.map((n: any) => n.appointmentId)).toEqual([ids.bPrevNone]);
    const ownerA = json(await (await login(env.app, A.owner.email)).get('/api/dashboard'));
    expect(ownerA.pendingNotes.map((n: any) => n.appointmentId)).not.toContain(ids.bPrevNone);
  });
});
