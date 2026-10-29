import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent, buildTenant, createMember, json, login, ORIGIN, PASSWORD, setupEnv, uniq, type Tenant, type TestEnv } from './helpers.ts';

let env: TestEnv;
let A: Tenant;
let B: Tenant;

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
  B = await buildTenant(env.adminPool, 'B');
});
afterAll(() => env.close());

const tokenFrom = (url: string) => url.split('#token=')[1];

describe('Autentikasi', () => {
  it('login berhasil membuat sesi dan /auth/me mengembalikan organisasi & role dari server', async () => {
    const agent = await login(env.app, A.owner.email);
    const me = json(await agent.get('/api/auth/me'));
    expect(me.organization.id).toBe(A.orgId);
    expect(me.membership.role).toBe('owner');
    expect(me.permissions).toContain('staff.manage');
    expect(me.csrfToken).toBeTruthy();
  });

  it('pesan gagal login sama untuk email tidak dikenal dan kata sandi salah', async () => {
    const unknown = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'tidak.ada@demo.invalid', password: 'salahsalah' } });
    const wrong = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: A.admin.email, password: 'salahsalah' } });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(json(unknown).error.message).toBe(json(wrong).error.message);
  });

  it('akun dikunci sementara setelah 5 kali gagal, termasuk untuk kata sandi benar', async () => {
    const victim = await createMember(env.adminPool, A.orgId, 'admin', 'kunci');
    for (let i = 0; i < 5; i++) {
      await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: victim.email, password: 'salah-salah-salah' } });
    }
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: victim.email, password: PASSWORD } });
    expect(res.statusCode).toBe(401);
    const { rows } = await env.adminPool.query(`SELECT locked_until > now() AS locked FROM users WHERE id = $1`, [victim.userId]);
    expect(rows[0].locked).toBe(true);
  });

  it('pembatasan laju login aktif (429 setelah melewati batas)', async () => {
    const { buildApp } = await import('../src/app.ts');
    const limited = await buildApp({ ...env.config, authRateLimitPerMinute: 3 }, env.appPool);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await limited.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@demo.invalid', password: 'salahsalah' } });
      codes.push(r.statusCode);
    }
    await limited.close();
    expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
    expect(codes[4]).toBe(429);
  });

  it('akun nonaktif ditolak saat login', async () => {
    const m = await createMember(env.adminPool, A.orgId, 'admin', 'nonaktif');
    await env.adminPool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [m.userId]);
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: m.email, password: PASSWORD } });
    expect(res.statusCode).toBe(401);
  });

  it('logout mencabut sesi di server', async () => {
    const agent = await login(env.app, A.admin.email);
    expect((await agent.post('/api/auth/logout')).statusCode).toBe(200);
    expect((await agent.get('/api/patients')).statusCode).toBe(401);
  });

  it('permintaan yang mengubah data tanpa token CSRF ditolak', async () => {
    const agent = await login(env.app, A.admin.email);
    const res = await agent.request('POST', '/api/patients', { fullName: 'DEMO Tanpa CSRF' }, { 'x-csrf-token': 'salah' });
    expect(res.statusCode).toBe(403);
    expect(json(res).error.code).toBe('csrf');
  });

  it('permintaan lintas situs (Origin asing / Sec-Fetch-Site cross-site) ditolak', async () => {
    const agent = await login(env.app, A.admin.email);
    const evil = await agent.request('POST', '/api/patients', { fullName: 'DEMO Lintas' }, { origin: 'https://jahat.invalid' });
    expect(evil.statusCode).toBe(403);
    const cross = await agent.request('POST', '/api/patients', { fullName: 'DEMO Lintas' }, { 'sec-fetch-site': 'cross-site' });
    expect(cross.statusCode).toBe(403);
  });

  it('header keamanan & no-store dikirim pada respons API', async () => {
    const agent = await login(env.app, A.admin.email);
    const res = await agent.get('/api/patients');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(String(res.headers['content-security-policy'])).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const cookie = (await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: A.admin.email, password: PASSWORD } })).cookies[0];
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
  });
});

describe('Keanggotaan & pengelolaan staf', () => {
  it('owner mengundang staf, staf aktivasi lewat tautan sekali pakai, lalu bisa login ke organisasi yang benar', async () => {
    const owner = await login(env.app, A.owner.email);
    const email = `baru.${uniq()}@demo.invalid`;
    const inv = await owner.post('/api/staff/invitations', { email, fullName: 'DEMO Staf Baru', role: 'terapis' });
    expect(inv.statusCode).toBe(201);
    const token = tokenFrom(json(inv).url);

    const info = await env.app.inject({ method: 'POST', url: '/api/auth/token-info', payload: { token }, headers: { origin: ORIGIN } });
    expect(json(info).organizationName).toBe(A.name);

    const accept = await env.app.inject({ method: 'POST', url: '/api/auth/accept-invitation', payload: { token, password: 'SandiBaruAman#1' } });
    expect(accept.statusCode).toBe(200);
    const again = await env.app.inject({ method: 'POST', url: '/api/auth/accept-invitation', payload: { token, password: 'SandiBaruAman#1' } });
    expect(again.statusCode).toBe(400);

    const staff = await login(env.app, email, 'SandiBaruAman#1');
    const me = json(await staff.get('/api/auth/me'));
    expect(me.organization.id).toBe(A.orgId);
    expect(me.membership.role).toBe('terapis');
    expect(me.membership.isTherapist).toBe(true);
  });

  it('peran owner tidak dapat diberikan lewat aplikasi (validasi API & kebijakan database)', async () => {
    const owner = await login(env.app, A.owner.email);
    const inv = await owner.post('/api/staff/invitations', { email: `o.${uniq()}@demo.invalid`, fullName: 'DEMO Calon Owner', role: 'owner' });
    expect(inv.statusCode).toBe(400);
    const patch = await owner.patch(`/api/staff/${A.admin.memberId}`, { role: 'owner' });
    expect(patch.statusCode).toBe(400);
  });

  it('owner tidak dapat mengubah akun sendiri atau akun owner', async () => {
    const owner = await login(env.app, A.owner.email);
    expect((await owner.post(`/api/staff/${A.owner.memberId}/deactivate`)).statusCode).toBe(403);
  });

  it('admin/terapis/keuangan tidak dapat mengelola staf', async () => {
    for (const p of [A.admin, A.therapist, A.finance]) {
      const agent = await login(env.app, p.email);
      const res = await agent.post('/api/staff/invitations', { email: `x.${uniq()}@demo.invalid`, fullName: 'DEMO X', role: 'admin' });
      expect(res.statusCode).toBe(403);
    }
  });

  it('owner A tidak dapat mengelola staf organisasi B (404, tanpa membocorkan keberadaan)', async () => {
    const owner = await login(env.app, A.owner.email);
    for (const path of [`/api/staff/${B.therapist.memberId}/deactivate`, `/api/staff/${B.therapist.memberId}/reset-link`]) {
      expect((await owner.post(path)).statusCode).toBe(404);
    }
    expect((await owner.patch(`/api/staff/${B.therapist.memberId}`, { role: 'admin' })).statusCode).toBe(404);
    const list = json<any[]>(await owner.get('/api/staff'));
    expect(list.some((m) => m.id === B.therapist.memberId)).toBe(false);
  });

  it('mengundang email yang sudah terdaftar di organisasi lain tidak membocorkan informasi ke pengundang', async () => {
    const ownerB = await login(env.app, B.owner.email);
    const res = await ownerB.post('/api/staff/invitations', { email: A.therapist.email, fullName: 'DEMO Coba', role: 'terapis' });
    // Respons sama seperti undangan biasa.
    expect(res.statusCode).toBe(201);
    // Penerima (pemilik email) yang mendapat penjelasan saat aktivasi, dan tetap tidak pindah organisasi.
    const accept = await env.app.inject({
      method: 'POST',
      url: '/api/auth/accept-invitation',
      payload: { token: tokenFrom(json(res).url), password: 'SandiBaruAman#1' },
    });
    expect(accept.statusCode).toBe(409);
    const { rows } = await env.adminPool.query(`SELECT organization_id FROM memberships WHERE user_id = $1`, [A.therapist.userId]);
    expect(rows).toEqual([{ organization_id: A.orgId }]);
  });

  it('organization_id yang dikirim klien diabaikan; data selalu masuk ke organisasi sesi', async () => {
    const admin = await login(env.app, A.admin.email);
    const res = await admin.post('/api/patients', { fullName: 'DEMO Coba Pindah', organizationId: B.orgId, organization_id: B.orgId });
    expect(res.statusCode).toBe(201);
    const { rows } = await env.adminPool.query(`SELECT organization_id FROM patients WHERE id = $1`, [json(res).id]);
    expect(rows[0].organization_id).toBe(A.orgId);
  });

  it('menonaktifkan staf langsung memutus sesi yang sedang berjalan', async () => {
    const m = await createMember(env.adminPool, A.orgId, 'admin', 'putus');
    const staff = await login(env.app, m.email);
    expect((await staff.get('/api/patients')).statusCode).toBe(200);
    const owner = await login(env.app, A.owner.email);
    expect((await owner.post(`/api/staff/${m.memberId}/deactivate`)).statusCode).toBe(200);
    expect((await staff.get('/api/patients')).statusCode).toBe(401);
    // Login baru juga ditolak.
    const relogin = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: m.email, password: PASSWORD } });
    expect(relogin.statusCode).toBe(401);
  });

  it('perubahan role langsung berlaku pada permintaan berikutnya', async () => {
    const m = await createMember(env.adminPool, A.orgId, 'keuangan', 'ubahrole');
    const staff = await login(env.app, m.email);
    expect((await staff.get(`/api/payments?from=2026-01-01&to=2026-12-31`)).statusCode).toBe(200);
    const owner = await login(env.app, A.owner.email);
    expect((await owner.patch(`/api/staff/${m.memberId}`, { role: 'admin' })).statusCode).toBe(200);
    expect((await staff.get(`/api/payments?from=2026-01-01&to=2026-12-31`)).statusCode).toBe(403);
  });

  it('tautan reset kata sandi: sekali pakai, mencabut sesi lama, dan kata sandi baru berlaku', async () => {
    const m = await createMember(env.adminPool, A.orgId, 'admin', 'reset');
    const oldSession = await login(env.app, m.email);
    const owner = await login(env.app, A.owner.email);
    const link = json(await owner.post(`/api/staff/${m.memberId}/reset-link`));
    const token = tokenFrom(link.url);
    const r = await env.app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token, password: 'SandiResetBaru#9' } });
    expect(r.statusCode).toBe(200);
    expect((await oldSession.get('/api/patients')).statusCode).toBe(401);
    await expect(login(env.app, m.email, 'SandiResetBaru#9')).resolves.toBeInstanceOf(Agent);
    const reuse = await env.app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token, password: 'SandiResetBaru#10' } });
    expect(reuse.statusCode).toBe(400);
  });

  it('kata sandi lemah ditolak dan hash tidak pernah dikirim ke klien', async () => {
    const owner = await login(env.app, A.owner.email);
    const inv = json(await owner.post('/api/staff/invitations', { email: `lemah.${uniq()}@demo.invalid`, fullName: 'DEMO Lemah', role: 'admin' }));
    const weak = await env.app.inject({ method: 'POST', url: '/api/auth/accept-invitation', payload: { token: tokenFrom(inv.url), password: 'pendek' } });
    expect(weak.statusCode).toBe(400);
    const staff = await owner.get('/api/staff');
    expect(staff.body).not.toContain('scrypt$');
    expect(staff.body).not.toContain('password');
  });

  it('perubahan keanggotaan tercatat di audit log', async () => {
    const { rows } = await env.adminPool.query(
      `SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE 'staf.%'`,
      [A.orgId],
    );
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['staf.diundang', 'staf.aktivasi', 'staf.dinonaktifkan', 'staf.diubah']));
  });
});
