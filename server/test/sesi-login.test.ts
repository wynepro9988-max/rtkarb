import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTenant, createMember, login, setupEnv, type Tenant, type TestEnv } from './helpers.ts';

// Keputusan owner 8 Nov 2026: pengguna tidak keluar otomatis; sesi berakhir hanya bila pengguna keluar
// (atau sandi diganti/direset, akun dinonaktifkan, atau sesi tidak dipakai selama batas hari).
let env: TestEnv;
let A: Tenant;

beforeAll(async () => {
  env = await setupEnv();
  A = await buildTenant(env.adminPool, 'A');
});
afterAll(() => env.close());

const DAY = 86_400_000;
const setCookies = (res: { headers: Record<string, unknown> }) => [res.headers['set-cookie'] ?? []].flat() as string[];
async function freshSession(label: string) {
  const m = await createMember(env.adminPool, A.orgId, 'admin', label);
  const agent = await login(env.app, m.email);
  const session = async () =>
    (await env.adminPool.query(`SELECT expires_at, last_seen_at, revoked_at FROM sessions WHERE user_id = $1`, [m.userId])).rows[0];
  const age = (sql: string) => env.adminPool.query(`UPDATE sessions SET ${sql} WHERE user_id = $1`, [m.userId]);
  return { agent, session, age };
}

describe('Login bertahan sampai pengguna keluar', () => {
  it('tidak dipakai 30 hari tetap masuk; masa berlaku sesi & cookie diperpanjang 400 hari', async () => {
    const { agent, session, age } = await freshSession('sesi1');
    expect(env.config.sessionIdleMinutes).toBe(0);
    await age(`last_seen_at = now() - interval '30 days', expires_at = now() + interval '5 days'`);
    const res = await agent.get('/api/auth/me');
    expect(res.statusCode).toBe(200);
    const s = await session();
    expect(s.expires_at.getTime()).toBeGreaterThan(Date.now() + 399 * DAY);
    expect(s.last_seen_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
    const cookie = setCookies(res).find((c) => c.startsWith('rb_sid='));
    expect(cookie).toContain(`Max-Age=${400 * 86_400}`);
    expect(cookie).toContain('HttpOnly');
    // Perpanjangan paling sering sekali sehari: permintaan berikutnya tidak mengirim cookie lagi.
    expect(setCookies(await agent.get('/api/auth/me'))).toEqual([]);
  });

  it('keluar tetap mencabut sesi walau perpanjangan jatuh pada permintaan yang sama', async () => {
    const { agent, session, age } = await freshSession('sesi2');
    await age(`expires_at = now() + interval '2 days'`);
    const res = await agent.post('/api/auth/logout');
    expect(res.statusCode).toBe(200);
    const cookies = setCookies(res).filter((c) => c.startsWith('rb_sid='));
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/^rb_sid=;/);
    expect((await session()).revoked_at).not.toBeNull();
    expect((await agent.get('/api/auth/me')).statusCode).toBe(401);
  });

  it('sesi yang sudah lewat masa berlakunya ditolak', async () => {
    const { agent, age } = await freshSession('sesi3');
    await age(`expires_at = now() - interval '1 minute'`);
    expect((await agent.get('/api/auth/me')).statusCode).toBe(401);
  });
});

describe('Batas idle tetap dapat diaktifkan lewat SESSION_IDLE_MINUTES', () => {
  it('dengan batas 60 menit, sesi yang diam 2 jam ditolak', async () => {
    const strict = await setupEnv({ sessionIdleMinutes: 60 });
    try {
      const T = await buildTenant(strict.adminPool, 'S');
      const agent = await login(strict.app, T.owner.email);
      expect((await agent.get('/api/auth/me')).statusCode).toBe(200);
      await strict.adminPool.query(`UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE user_id = $1`, [T.owner.userId]);
      expect((await agent.get('/api/auth/me')).statusCode).toBe(401);
    } finally {
      await strict.close();
    }
  });
});
