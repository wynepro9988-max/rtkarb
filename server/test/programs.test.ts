import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../src/db.ts';
import { buildTenant, json, login, setupEnv, type Agent, type Tenant, type TestEnv } from './helpers.ts';

let env: TestEnv;
let A: Tenant;
let B: Tenant;
let therapist: Agent;
let programId: string;
let goalId: string;

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  B = await buildTenant(env.adminPool, 'B');
  therapist = await login(env.app, A.therapist.email);
});
afterAll(() => env.close());

describe('Program terapi (rencana jangka panjang per anak)', () => {
  it('terapis yang ditugaskan membuat program dengan tujuan, lalu mencatat capaian', async () => {
    const res = await therapist.post(`/api/patients/${A.patientId}/programs`, {
      title: 'DEMO Program komunikasi semester 1',
      serviceId: A.serviceId,
      summary: 'DEMO ringkasan klinis program',
      startDate: '2026-10-01',
      targetEndDate: '2027-03-31',
      goals: [{ description: 'DEMO tujuan kontak mata 5 detik', successCriteria: 'DEMO 4 dari 5 percobaan' }, { description: 'DEMO tujuan menunjuk benda' }],
    });
    expect(res.statusCode, res.body).toBe(201);
    programId = json(res).id;
    const list = json<any[]>(await therapist.get(`/api/patients/${A.patientId}/programs`));
    expect(list[0].goals).toHaveLength(2);
    goalId = list[0].goals[0].id;

    expect((await therapist.post(`/api/goals/${goalId}/progress`, { progressPercent: 40, note: 'DEMO capaian awal' })).statusCode).toBe(201);
    expect((await therapist.post(`/api/goals/${goalId}/progress`, { progressPercent: 70 })).statusCode).toBe(201);
    const after = json<any[]>(await therapist.get(`/api/patients/${A.patientId}/programs`));
    expect(after[0].goals[0].latestProgress).toBe(70);
    const history = json<any[]>(await therapist.get(`/api/goals/${goalId}/progress`));
    expect(history.map((h) => h.progressPercent)).toEqual([70, 40]);
  });

  it('tujuan tercapai tidak menerima capaian baru; program ditutup wajib dengan ringkasan', async () => {
    expect((await therapist.patch(`/api/goals/${goalId}`, { status: 'tercapai' })).statusCode).toBe(200);
    expect((await therapist.post(`/api/goals/${goalId}/progress`, { progressPercent: 90 })).statusCode).toBe(400);
    expect((await therapist.patch(`/api/programs/${programId}`, { status: 'selesai' })).statusCode).toBe(400);
    expect((await therapist.patch(`/api/programs/${programId}`, { status: 'selesai', endReason: 'DEMO target tercapai' })).statusCode).toBe(200);
  });

  it('terapis lain (tidak ditugaskan), admin, dan keuangan tidak dapat membaca maupun menulis program', async () => {
    const t2 = await login(env.app, A.therapist2.email);
    expect((await t2.get(`/api/patients/${A.patientId}/programs`)).statusCode).toBe(404);
    expect((await t2.patch(`/api/programs/${programId}`, { title: 'diambil alih' })).statusCode).toBe(404);
    for (const p of [A.admin, A.finance]) {
      const agent = await login(env.app, p.email);
      expect((await agent.get(`/api/patients/${A.patientId}/programs`)).statusCode).toBe(403);
    }
    // Lapisan database: cakupan catatan "none" tidak melihat program.
    const n = await withTx(
      env.appPool,
      { settings: { 'app.mode': 'tenant', 'app.org_id': A.orgId, 'app.member_id': A.admin.memberId, 'app.scope_patient': 'all', 'app.scope_note': 'none' } },
      async (db) => (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM therapy_programs`)).n,
    );
    expect(n).toBe(0);
  });

  it('organisasi lain tidak dapat mengakses program A', async () => {
    const ownerB = await login(env.app, B.owner.email);
    expect((await ownerB.get(`/api/goals/${goalId}/progress`)).statusCode).toBe(404);
    expect((await ownerB.patch(`/api/programs/${programId}`, { title: 'DEMO diambil alih' })).statusCode).toBe(404);
    const owner = await login(env.app, A.owner.email);
    expect(json<any[]>(await owner.get(`/api/patients/${A.patientId}/programs`))).toHaveLength(1);
  });

  it('riwayat capaian bersifat append-only dan audit tidak memuat isi klinis', async () => {
    await expect(env.adminPool.query(`UPDATE goal_progress SET progress_percent = 1`)).rejects.toThrow(/append-only/);
    const { rows } = await env.adminPool.query(`SELECT meta::text AS m FROM audit_logs WHERE organization_id = $1 AND action LIKE 'program.%'`, [A.orgId]);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.m).not.toContain('DEMO tujuan');
  });
});
