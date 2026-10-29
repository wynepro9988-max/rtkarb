import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTenant, createUser, json, login, setupEnv, type Agent, type Tenant, type TestEnv } from './helpers.ts';

let env: TestEnv;
let A: Tenant;
let B: Tenant;
let platform: Agent;
let ownerA: Agent;
let platformUserId: string;

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  B = await buildTenant(env.adminPool, 'B');
  const p = await createUser(env.adminPool, 'platform', true);
  platformUserId = p.userId;
  platform = await login(env.app, p.email);
  ownerA = await login(env.app, A.owner.email);
  const t = await login(env.app, A.therapist.email);
  await t.post('/api/notes', { patientId: A.patientId, observations: 'DEMO catatan klinis rahasia' });
});
afterAll(() => env.close());

async function requestAccess(scopes: string[], durationMinutes = 60) {
  const res = await platform.post('/api/platform/support-requests', {
    organizationId: A.orgId,
    reason: 'Investigasi laporan error pada halaman jadwal',
    scopes,
    durationMinutes,
  });
  expect(res.statusCode, res.body).toBe(201);
  return json(res).id as string;
}

describe('Akses dukungan teknis terbatas', () => {
  it('admin teknis tidak memiliki akses data organisasi secara default', async () => {
    for (const p of ['/api/patients', `/api/patients/${A.patientId}`, '/api/dashboard', '/api/org', `/api/payments?from=2026-01-01&to=2026-12-31`]) {
      expect((await platform.get(p)).statusCode, p).toBe(403);
    }
    const orgs = json<any[]>(await platform.get('/api/platform/organizations'));
    expect(Object.keys(orgs[0]).sort()).toEqual(['createdAt', 'id', 'name', 'status']);
  });

  it('akses belum dapat dipakai sebelum disetujui owner', async () => {
    const id = await requestAccess(['patient.read', 'schedule.read']);
    expect((await platform.post(`/api/platform/support-requests/${id}/enter`)).statusCode).toBe(403);
    expect((await platform.get('/api/patients')).statusCode).toBe(403);
  });

  it('admin teknis tidak dapat menyetujui permintaannya sendiri; owner B tidak dapat menyetujui permintaan untuk A', async () => {
    const id = await requestAccess(['patient.read', 'schedule.read']);
    expect((await platform.post(`/api/support/requests/${id}/approve`)).statusCode).toBe(403);
    const ownerB = await login(env.app, B.owner.email);
    expect((await ownerB.post(`/api/support/requests/${id}/approve`)).statusCode).toBe(404);
  });

  it('setelah disetujui: hanya cakupan yang disetujui, baca-saja, dan setiap permintaan tercatat', async () => {
    const id = await requestAccess(['patient.read', 'schedule.read']);
    expect((await ownerA.post(`/api/support/requests/${id}/approve`, { note: 'Disetujui 1 jam' })).statusCode).toBe(200);
    expect((await platform.post(`/api/platform/support-requests/${id}/enter`)).statusCode).toBe(200);

    const me = json(await platform.get('/api/auth/me'));
    expect(me.mode).toBe('support');
    expect(me.organization.id).toBe(A.orgId);

    expect((await platform.get('/api/patients')).statusCode).toBe(200);
    // Di luar cakupan: catatan klinis, keuangan, organisasi lain.
    const notes = await platform.get(`/api/patients/${A.patientId}/notes`);
    expect(notes.statusCode).toBe(403);
    expect(notes.body).not.toContain('rahasia');
    expect((await platform.get(`/api/payments?from=2026-01-01&to=2026-12-31`)).statusCode).toBe(403);
    expect((await platform.get(`/api/patients/${B.patientId}`)).statusCode).toBe(404);
    // Tidak dapat menulis apa pun.
    expect((await platform.post('/api/patients', { fullName: 'DEMO Dari Dukungan' })).statusCode).toBe(403);
    expect((await platform.patch(`/api/patients/${A.patientId}`, { nickname: 'x' })).statusCode).toBe(403);
    expect((await platform.post(`/api/support/requests/${id}/approve`)).statusCode).toBe(403);

    const { rows } = await env.adminPool.query(
      `SELECT action, meta FROM audit_logs WHERE organization_id = $1 AND support_grant_id = $2 ORDER BY id`,
      [A.orgId, id],
    );
    const actions = rows.map((r) => r.action);
    expect(actions[0]).toBe('dukungan.masuk');
    expect(actions.filter((a) => a === 'dukungan.akses').length).toBeGreaterThanOrEqual(6);
    expect(rows.find((r) => r.action === 'dukungan.akses').meta).toHaveProperty('rute');

    // Owner melihat aktivitas dukungan di audit log organisasinya.
    const audit = json(await ownerA.get(`/api/audit?from=2026-01-01&to=2026-12-31&action=dukungan&limit=200`));
    expect(audit.items.some((l: any) => l.viaSupport && l.actorName.startsWith('DEMO platform'))).toBe(true);
    await platform.post('/api/platform/support/exit');
  });

  it('cakupan yang bergantung pada data pasien wajib menyertakan patient.read', async () => {
    const res = await platform.post('/api/platform/support-requests', {
      organizationId: A.orgId,
      reason: 'Investigasi catatan tidak tersimpan',
      scopes: ['therapy.note.read'],
      durationMinutes: 30,
    });
    expect(res.statusCode).toBe(400);
  });

  it('catatan klinis hanya terbaca bila cakupan therapy.note.read disetujui secara eksplisit', async () => {
    const id = await requestAccess(['patient.read', 'therapy.note.read']);
    await ownerA.post(`/api/support/requests/${id}/approve`);
    await platform.post(`/api/platform/support-requests/${id}/enter`);
    const notes = await platform.get(`/api/patients/${A.patientId}/notes`);
    expect(notes.statusCode).toBe(200);
    await platform.post('/api/platform/support/exit');
    expect((await platform.get(`/api/patients/${A.patientId}/notes`)).statusCode).toBe(403);
  });

  it('pencabutan oleh owner berlaku seketika', async () => {
    const id = await requestAccess(['patient.read']);
    await ownerA.post(`/api/support/requests/${id}/approve`);
    await platform.post(`/api/platform/support-requests/${id}/enter`);
    expect((await platform.get('/api/patients')).statusCode).toBe(200);
    expect((await ownerA.post(`/api/support/requests/${id}/revoke`)).statusCode).toBe(200);
    expect((await platform.get('/api/patients')).statusCode).toBe(403);
    expect((await platform.post(`/api/platform/support-requests/${id}/enter`)).statusCode).toBe(403);
  });

  it('akses yang kedaluwarsa ditolak', async () => {
    const id = await requestAccess(['patient.read'], 15);
    await ownerA.post(`/api/support/requests/${id}/approve`);
    await platform.post(`/api/platform/support-requests/${id}/enter`);
    expect((await platform.get('/api/patients')).statusCode).toBe(200);
    await env.adminPool.query(`UPDATE support_access_grants SET starts_at = now() - interval '20 minutes', expires_at = now() - interval '1 second' WHERE id = $1`, [id]);
    expect((await platform.get('/api/patients')).statusCode).toBe(403);
    const list = json<any[]>(await ownerA.get('/api/support/requests'));
    expect(list.find((g) => g.id === id).state).toBe('kedaluwarsa');
  });

  it('cakupan yang tidak dikenal atau bersifat tulis ditolak saat pengajuan', async () => {
    const res = await platform.post('/api/platform/support-requests', {
      organizationId: A.orgId,
      reason: 'Mencoba meminta hak tulis',
      scopes: ['patient.manage'],
      durationMinutes: 60,
    });
    expect(res.statusCode).toBe(400);
    const { rows } = await env.adminPool.query(`SELECT count(*)::int AS n FROM memberships WHERE user_id = $1`, [platformUserId]);
    expect(rows[0].n).toBe(0);
  });
});
