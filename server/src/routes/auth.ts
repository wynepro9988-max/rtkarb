import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.ts';
import {
  authTx,
  clearSessionCookie,
  describeContext,
  needAuth,
  selfTx,
  setLocal,
  setSessionCookie,
} from '../authz/context.ts';
import { badRequest, conflict, HttpError } from '../errors.ts';
import { parse } from '../http.ts';
import { burnPasswordCheck, hashPassword, passwordProblem, PASSWORD_MAX, verifyPassword } from '../security/password.ts';
import { newToken, sha256Hex } from '../security/tokens.ts';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const LOGIN_FAILED = 'Email atau kata sandi salah, atau akun sedang dikunci sementara. Coba lagi beberapa saat lagi.';
const TOKEN_INVALID = 'Tautan tidak valid, sudah dipakai, atau sudah kedaluwarsa. Minta tautan baru kepada pengelola.';

const loginBody = z.object({
  email: z.string().trim().toLowerCase().min(3).max(200),
  password: z.string().min(1).max(PASSWORD_MAX),
});
const tokenBody = z.object({ token: z.string().min(20).max(200) });
const passwordField = z.string().min(1).max(PASSWORD_MAX);

export async function authRoutes(app: FastifyInstance) {
  const strict = { config: { rateLimit: { max: app.config.authRateLimitPerMinute, timeWindow: '1 minute' } } };

  app.post('/auth/login', strict, async (req, reply) => {
    const { email, password } = parse(loginBody, req.body);
    const result = await authTx(app, async (db) => {
      const fail = async (userId: string | null, reason: string) => {
        await writeAudit(db, req, { orgId: null, userId }, { action: 'auth.login_gagal', meta: { alasan: reason } });
        return { ok: false as const, noAccess: false };
      };

      const user = await db.maybe<{
        id: string;
        passwordHash: string;
        status: string;
        platformRole: string | null;
        failedLoginCount: number;
        lockedUntil: Date | null;
      }>(
        `SELECT id, password_hash, status, platform_role, failed_login_count, locked_until
           FROM users WHERE email = $1 FOR UPDATE`,
        [email],
      );
      if (!user) {
        await burnPasswordCheck(password);
        return fail(null, 'akun_tidak_dikenal');
      }
      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        await burnPasswordCheck(password);
        return fail(user.id, 'akun_terkunci');
      }
      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        const count = user.failedLoginCount + 1;
        if (count >= MAX_FAILED) {
          await db.exec(
            `UPDATE users SET failed_login_count = 0, locked_until = now() + make_interval(mins => $2) WHERE id = $1`,
            [user.id, LOCK_MINUTES],
          );
        } else {
          await db.exec(`UPDATE users SET failed_login_count = $2 WHERE id = $1`, [user.id, count]);
        }
        return fail(user.id, count >= MAX_FAILED ? 'kata_sandi_salah_dikunci' : 'kata_sandi_salah');
      }
      if (user.status !== 'active') return fail(user.id, 'akun_nonaktif');

      let orgId: string | null = null;
      if (user.platformRole !== 'platform_admin') {
        await setLocal(db, { 'app.user_id': user.id });
        const m = await db.maybe<{ organizationId: string }>(
          `SELECT m.organization_id FROM memberships m
             JOIN organizations o ON o.id = m.organization_id
            WHERE m.user_id = $1 AND m.status = 'active' AND o.status = 'active'`,
          [user.id],
        );
        if (!m) {
          await writeAudit(db, req, { orgId: null, userId: user.id }, { action: 'auth.login_ditolak', meta: { alasan: 'tanpa_keanggotaan_aktif' } });
          return { ok: false as const, noAccess: true };
        }
        orgId = m.organizationId;
      }

      const token = newToken();
      await db.exec(
        `INSERT INTO sessions (token_hash, user_id, organization_id, csrf_token, ip, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7))`,
        [sha256Hex(token), user.id, orgId, newToken(24), req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300), app.config.sessionMaxDays],
      );
      await db.exec(`UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [user.id]);
      await db.exec(
        `DELETE FROM sessions WHERE user_id = $1 AND (expires_at < now() OR revoked_at < now() - interval '30 days')`,
        [user.id],
      );
      await writeAudit(db, req, { orgId, userId: user.id }, { action: 'auth.login' });
      return { ok: true as const, token };
    });

    if (!result.ok) {
      throw new HttpError(
        401,
        result.noAccess
          ? 'Akun Anda tidak memiliki akses aktif ke organisasi. Hubungi owner organisasi Anda.'
          : LOGIN_FAILED,
        'login_failed',
      );
    }
    setSessionCookie(app, reply, result.token);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => describeContext(needAuth(req)));

  app.post('/auth/logout', async (req, reply) => {
    const ctx = req.auth;
    if (ctx) {
      await selfTx(app, ctx, async (db) => {
        await db.exec(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [ctx.sessionId]);
        await writeAudit(db, req, { orgId: ctx.mode === 'tenant' ? ctx.orgId : null, userId: ctx.userId }, { action: 'auth.logout' });
      });
    }
    clearSessionCookie(app, reply);
    return { ok: true };
  });

  app.post('/auth/logout-all', async (req, reply) => {
    const ctx = needAuth(req);
    const count = await selfTx(app, ctx, async (db) => {
      const n = await db.exec(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [ctx.userId]);
      await writeAudit(db, req, { orgId: ctx.mode === 'tenant' ? ctx.orgId : null, userId: ctx.userId }, {
        action: 'auth.logout_semua',
        meta: { jumlah_sesi: n },
      });
      return n;
    });
    clearSessionCookie(app, reply);
    return { ok: true, revokedSessions: count };
  });

  app.post('/auth/change-password', strict, async (req) => {
    const ctx = needAuth(req);
    const body = parse(z.object({ currentPassword: passwordField, newPassword: passwordField }), req.body);
    const problem = passwordProblem(body.newPassword, ctx.email);
    if (problem) throw badRequest(problem);
    if (body.currentPassword === body.newPassword) throw badRequest('Kata sandi baru harus berbeda dari kata sandi lama');

    await selfTx(app, ctx, async (db) => {
      const u = await db.one<{ passwordHash: string }>(`SELECT password_hash FROM users WHERE id = $1 FOR UPDATE`, [ctx.userId]);
      if (!(await verifyPassword(body.currentPassword, u.passwordHash))) {
        throw new HttpError(400, 'Kata sandi saat ini salah', 'wrong_password');
      }
      await db.exec(`UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [
        ctx.userId,
        await hashPassword(body.newPassword),
      ]);
      // Sesi lain ditutup; sesi yang sedang dipakai tetap berlaku.
      await db.exec(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [
        ctx.userId,
        ctx.sessionId,
      ]);
      await writeAudit(db, req, { orgId: ctx.mode === 'tenant' ? ctx.orgId : null, userId: ctx.userId }, { action: 'auth.ganti_sandi' });
    });
    return { ok: true };
  });

  // Info tautan aktivasi / reset. Token dikirim lewat body (bukan URL) agar tidak tercatat di log.
  app.post('/auth/token-info', strict, async (req) => {
    const { token } = parse(tokenBody, req.body);
    const hash = sha256Hex(token);
    const info = await authTx(
      app,
      (db) =>
        db.maybe<{ purpose: string; email: string; fullName: string | null; role: string | null; organizationName: string; expiresAt: Date }>(
          `SELECT t.purpose, t.email, t.full_name, t.role, o.name AS organization_name, t.expires_at
             FROM account_tokens t JOIN organizations o ON o.id = t.organization_id
            WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now()`,
          [hash],
        ),
      hash,
    );
    if (!info) throw new HttpError(400, TOKEN_INVALID, 'token_invalid');
    return info;
  });

  app.post('/auth/accept-invitation', strict, async (req) => {
    const body = parse(
      tokenBody.extend({ password: passwordField, fullName: z.string().trim().min(2).max(150).optional() }),
      req.body,
    );
    const hash = sha256Hex(body.token);
    await authTx(
      app,
      async (db) => {
        const t = await db.maybe<{
          id: string;
          organizationId: string;
          email: string;
          fullName: string;
          role: string;
          isTherapist: boolean;
          handlesFinance: boolean;
          specialization: string | null;
          createdBy: string | null;
        }>(
          `SELECT id, organization_id, email, full_name, role, is_therapist, handles_finance, specialization, created_by
             FROM account_tokens
            WHERE token_hash = $1 AND purpose = 'undangan' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
            FOR UPDATE`,
          [hash],
        );
        if (!t) throw new HttpError(400, TOKEN_INVALID, 'token_invalid');
        const problem = passwordProblem(body.password, t.email);
        if (problem) throw badRequest(problem);

        const existing = await db.maybe(`SELECT 1 FROM users WHERE email = $1`, [t.email]);
        if (existing) {
          // Pesan ini hanya terlihat oleh pemilik email yang diundang, bukan oleh pengundang.
          throw conflict('Email ini sudah memiliki akun. Satu akun hanya dapat terdaftar pada satu organisasi. Hubungi pengelola.');
        }

        const user = await db.one<{ id: string }>(
          `INSERT INTO users (email, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
          [t.email, body.fullName ?? t.fullName, await hashPassword(body.password)],
        );
        await setLocal(db, { 'app.user_id': user.id });
        const member = await db.one<{ id: string }>(
          `INSERT INTO memberships (organization_id, user_id, role, is_therapist, handles_finance, specialization, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
          [t.organizationId, user.id, t.role, t.isTherapist || t.role === 'terapis', t.handlesFinance, t.specialization, t.createdBy],
        );
        await db.exec(`UPDATE account_tokens SET used_at = now() WHERE id = $1`, [t.id]);
        await writeAudit(db, req, { orgId: t.organizationId, userId: user.id, memberId: member.id }, {
          action: 'staf.aktivasi',
          entityType: 'membership',
          entityId: member.id,
          meta: { peran: t.role, undangan_id: t.id },
        });
      },
      hash,
    );
    return { ok: true };
  });

  app.post('/auth/reset-password', strict, async (req) => {
    const body = parse(tokenBody.extend({ password: passwordField }), req.body);
    const hash = sha256Hex(body.token);
    await authTx(
      app,
      async (db) => {
        const t = await db.maybe<{ id: string; organizationId: string; userId: string; email: string }>(
          `SELECT id, organization_id, user_id, email FROM account_tokens
            WHERE token_hash = $1 AND purpose = 'reset_sandi' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
            FOR UPDATE`,
          [hash],
        );
        if (!t) throw new HttpError(400, TOKEN_INVALID, 'token_invalid');
        const problem = passwordProblem(body.password, t.email);
        if (problem) throw badRequest(problem);
        await db.exec(
          `UPDATE users SET password_hash = $2, password_changed_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1`,
          [t.userId, await hashPassword(body.password)],
        );
        await db.exec(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [t.userId]);
        await db.exec(`UPDATE account_tokens SET used_at = now() WHERE id = $1`, [t.id]);
        await writeAudit(db, req, { orgId: t.organizationId, userId: t.userId }, { action: 'auth.reset_sandi', entityType: 'user', entityId: t.userId });
      },
      hash,
    );
    return { ok: true };
  });
}
