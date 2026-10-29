import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import type { FileStore } from '../lib/storage.ts';
import { withTx, type Db, type Pool } from '../db.ts';
import { forbidden, HttpError, unauthorized } from '../errors.ts';
import { sha256Hex } from '../security/tokens.ts';
import {
  dataScopes,
  permissionsForMember,
  permissionsForSupport,
  roleLabel,
  type Permission,
  type Role,
} from './permissions.ts';

export const SESSION_COOKIE = 'rb_sid';

export type Mode = 'tenant' | 'support' | 'platform';

export interface AuthContext {
  sessionId: string;
  userId: string;
  email: string;
  fullName: string;
  csrfToken: string;
  mode: Mode;
  orgId: string | null;
  orgName: string | null;
  timezone: string;
  memberId: string | null;
  role: Role | null;
  isTherapist: boolean;
  handlesFinance: boolean;
  permissions: ReadonlySet<Permission>;
  support: { grantId: string; expiresAt: string; scopes: string[] } | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyInstance {
    pool: Pool;
    config: Config;
    fileStore: FileStore;
  }
}

interface SessionRow {
  id: string;
  userId: string;
  organizationId: string | null;
  supportGrantId: string | null;
  csrfToken: string;
  lastSeenAt: Date;
}

async function setLocal(db: Db, settings: Record<string, string>): Promise<void> {
  const entries = Object.entries(settings);
  const calls = entries.map((_, i) => `set_config($${i * 2 + 1}, $${i * 2 + 2}, true)`);
  await db.exec(`SELECT ${calls.join(', ')}`, entries.flat());
}

export { setLocal };

// Dipanggil pada setiap permintaan /api. Tidak ada cache: penonaktifan staf,
// pencabutan sesi, dan kedaluwarsa akses dukungan berlaku seketika.
export async function resolveAuth(app: FastifyInstance, req: FastifyRequest): Promise<AuthContext | null> {
  const token = req.cookies[SESSION_COOKIE];
  if (!token || token.length > 200) return null;
  const tokenHash = sha256Hex(token);

  return withTx(app.pool, { settings: { 'app.mode': 'session' } }, async (db) => {
    const s = await db.maybe<SessionRow>(
      `SELECT id, user_id, organization_id, support_grant_id, csrf_token, last_seen_at
         FROM sessions
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
          AND last_seen_at > now() - make_interval(mins => $2)`,
      [tokenHash, app.config.sessionIdleMinutes],
    );
    if (!s) return null;

    await setLocal(db, { 'app.user_id': s.userId });
    const user = await db.maybe<{ id: string; email: string; fullName: string; status: string; platformRole: string | null }>(
      `SELECT id, email, full_name, status, platform_role FROM users WHERE id = $1`,
      [s.userId],
    );
    const revoke = () => db.exec(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [s.id]);
    if (!user || user.status !== 'active') {
      await revoke();
      return null;
    }

    const base = {
      sessionId: s.id,
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      csrfToken: s.csrfToken,
    };
    let ctx: AuthContext;

    if (user.platformRole === 'platform_admin') {
      await setLocal(db, { 'app.mode': 'platform' });
      const grant = s.supportGrantId
        ? await db.maybe<{ id: string; organizationId: string; scopes: string[]; expiresAt: Date; name: string; timezone: string }>(
            `SELECT g.id, g.organization_id, g.scopes, g.expires_at, o.name, o.timezone
               FROM support_access_grants g
               JOIN organizations o ON o.id = g.organization_id
              WHERE g.id = $1 AND g.requested_by = $2 AND g.status = 'disetujui'
                AND g.revoked_at IS NULL AND now() >= g.starts_at AND now() < g.expires_at
                AND o.status = 'active'`,
            [s.supportGrantId, user.id],
          )
        : null;
      if (s.supportGrantId && !grant) {
        await db.exec(`UPDATE sessions SET support_grant_id = NULL, organization_id = NULL WHERE id = $1`, [s.id]);
      }
      ctx = grant
        ? {
            ...base,
            mode: 'support',
            orgId: grant.organizationId,
            orgName: grant.name,
            timezone: grant.timezone,
            memberId: null,
            role: null,
            isTherapist: false,
            handlesFinance: false,
            permissions: permissionsForSupport(grant.scopes),
            support: { grantId: grant.id, expiresAt: grant.expiresAt.toISOString(), scopes: grant.scopes },
          }
        : {
            ...base,
            mode: 'platform',
            orgId: null,
            orgName: null,
            timezone: 'Asia/Jakarta',
            memberId: null,
            role: null,
            isTherapist: false,
            handlesFinance: false,
            permissions: new Set(),
            support: null,
          };
    } else {
      const m = s.organizationId
        ? await db.maybe<{ id: string; organizationId: string; role: Role; isTherapist: boolean; handlesFinance: boolean; name: string; timezone: string }>(
            `SELECT m.id, m.organization_id, m.role, m.is_therapist, m.handles_finance, o.name, o.timezone
               FROM memberships m
               JOIN organizations o ON o.id = m.organization_id
              WHERE m.user_id = $1 AND m.organization_id = $2
                AND m.status = 'active' AND o.status = 'active'`,
            [user.id, s.organizationId],
          )
        : null;
      if (!m) {
        await revoke();
        return null;
      }
      ctx = {
        ...base,
        mode: 'tenant',
        orgId: m.organizationId,
        orgName: m.name,
        timezone: m.timezone,
        memberId: m.id,
        role: m.role,
        isTherapist: m.isTherapist,
        handlesFinance: m.handlesFinance,
        permissions: permissionsForMember(m.role, m.handlesFinance),
        support: null,
      };
    }

    if (Date.now() - s.lastSeenAt.getTime() > 60_000) {
      await db.exec(`UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [s.id]);
    }
    return ctx;
  });
}

export function checkCsrf(req: FastifyRequest): void {
  const ctx = req.auth;
  if (!ctx) return;
  const header = req.headers['x-csrf-token'];
  const given = Buffer.from(typeof header === 'string' ? header : '');
  const expected = Buffer.from(ctx.csrfToken);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new HttpError(403, 'Token keamanan tidak valid. Muat ulang halaman lalu coba lagi.', 'csrf');
  }
}

export function needAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

// Pengguna harus berada dalam konteks organisasi dan memiliki salah satu permission.
export function needTenant(req: FastifyRequest, ...anyOf: Permission[]): AuthContext {
  const ctx = needAuth(req);
  if (!ctx.orgId || ctx.mode === 'platform') {
    throw forbidden('Akun ini tidak memiliki akses ke data organisasi');
  }
  if (anyOf.length > 0 && !anyOf.some((p) => ctx.permissions.has(p))) throw forbidden();
  return ctx;
}

export function needPlatform(req: FastifyRequest): AuthContext {
  const ctx = needAuth(req);
  if (ctx.mode !== 'platform') throw forbidden('Hanya untuk admin teknis platform di luar mode dukungan');
  return ctx;
}

export function can(ctx: AuthContext, ...anyOf: Permission[]): boolean {
  return anyOf.some((p) => ctx.permissions.has(p));
}

// Transaksi data tenant: konteks RLS di-set lokal. Mode dukungan = READ ONLY.
export function tenantTx<T>(app: FastifyInstance, ctx: AuthContext, fn: (db: Db) => Promise<T>): Promise<T> {
  if (!ctx.orgId) throw forbidden('Akun ini tidak memiliki akses ke data organisasi');
  const scopes = dataScopes(ctx.permissions);
  return withTx(
    app.pool,
    {
      readOnly: ctx.mode === 'support',
      settings: {
        'app.mode': ctx.mode === 'support' ? 'support' : 'tenant',
        'app.org_id': ctx.orgId,
        'app.user_id': ctx.userId,
        'app.member_id': ctx.memberId,
        'app.scope_patient': scopes.patient,
        'app.scope_note': scopes.note,
        'app.scope_finance': scopes.finance,
        'app.scope_audit': scopes.audit,
      },
    },
    fn,
  );
}

// Transaksi tugas terjadwal (cron) untuk SATU organisasi, tanpa pengguna. Cakupan hanya
// data administratif pasien (jadwal & wali); catatan klinis, keuangan, dan audit tertutup.
export function systemTenantTx<T>(app: FastifyInstance, orgId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  return withTx(
    app.pool,
    {
      settings: {
        'app.mode': 'tenant',
        'app.org_id': orgId,
        'app.scope_patient': 'all',
        'app.scope_note': 'none',
        'app.scope_finance': 'none',
        'app.scope_audit': 'none',
      },
    },
    fn,
  );
}

export function platformTx<T>(app: FastifyInstance, ctx: AuthContext, fn: (db: Db) => Promise<T>): Promise<T> {
  return withTx(app.pool, { settings: { 'app.mode': 'platform', 'app.user_id': ctx.userId } }, fn);
}

// Transaksi untuk alur login/aktivasi/reset (belum ada sesi).
export function authTx<T>(app: FastifyInstance, fn: (db: Db) => Promise<T>, tokenHash?: string): Promise<T> {
  return withTx(app.pool, { settings: { 'app.mode': 'auth', 'app.token_hash': tokenHash ?? null } }, fn);
}

// Transaksi untuk tindakan atas akun sendiri (ganti kata sandi, logout).
export function selfTx<T>(app: FastifyInstance, ctx: AuthContext, fn: (db: Db) => Promise<T>): Promise<T> {
  return withTx(
    app.pool,
    {
      settings: {
        'app.mode': 'self',
        'app.user_id': ctx.userId,
        'app.org_id': ctx.mode === 'tenant' ? ctx.orgId : null,
      },
    },
    fn,
  );
}

export function setSessionCookie(app: FastifyInstance, reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: app.config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: app.config.sessionMaxDays * 24 * 60 * 60,
  });
}

export function clearSessionCookie(app: FastifyInstance, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, secure: app.config.cookieSecure, sameSite: 'lax' });
}

export function describeContext(ctx: AuthContext) {
  return {
    user: { id: ctx.userId, email: ctx.email, fullName: ctx.fullName },
    mode: ctx.mode,
    organization: ctx.orgId ? { id: ctx.orgId, name: ctx.orgName, timezone: ctx.timezone } : null,
    membership: ctx.memberId
      ? {
          id: ctx.memberId,
          role: ctx.role,
          roleLabel: ctx.role ? roleLabel(ctx.role, ctx.handlesFinance) : null,
          isTherapist: ctx.isTherapist,
          handlesFinance: ctx.handlesFinance,
        }
      : null,
    permissions: [...ctx.permissions].sort(),
    csrfToken: ctx.csrfToken,
    support: ctx.support,
  };
}
