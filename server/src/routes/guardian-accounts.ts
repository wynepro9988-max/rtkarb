import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.ts';
import { needTenant, tenantTx } from '../authz/context.ts';
import type { Db } from '../db.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { idParam } from '../http.ts';
import { newToken, sha256Hex } from '../security/tokens.ts';
import { normalizePhone } from './reminders.ts';

const INVITE_HOURS = 72;
const RESET_HOURS = 24;

// Status akun wali untuk halaman pasien; `g` = guardians.
export const GUARDIAN_ACCOUNT_FIELDS = `g.member_id,
  (SELECT u.username FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = g.organization_id AND m.id = g.member_id) AS account_username,
  (SELECT max(t.expires_at) FROM account_tokens t
    WHERE t.organization_id = g.organization_id AND t.guardian_id = g.id AND t.purpose = 'undangan'
      AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now()) AS invite_expires_at`;

interface GuardianRow {
  patientId: string;
  fullName: string;
  phone: string | null;
  memberId: string | null;
}

async function loadGuardian(db: Db, orgId: string, id: string): Promise<GuardianRow> {
  const g = await db.maybe<GuardianRow>(
    `SELECT patient_id, full_name, phone, member_id FROM guardians WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
    [orgId, id],
  );
  if (!g) throw notFound('Wali');
  return g;
}

// Akun wali tanpa anak yang terhubung ditutup: tidak ada lagi yang boleh dilihatnya.
export async function closeGuardianAccountIfUnlinked(db: Db, orgId: string, memberId: string, actorUserId: string): Promise<void> {
  if (await db.maybe(`SELECT 1 FROM guardians WHERE organization_id = $1 AND member_id = $2 LIMIT 1`, [orgId, memberId])) return;
  const m = await db.maybe<{ userId: string }>(
    `UPDATE memberships SET status = 'inactive', deactivated_at = now(), updated_by = $3
      WHERE organization_id = $1 AND id = $2 AND role = 'wali' AND status = 'active' RETURNING user_id`,
    [orgId, memberId, actorUserId],
  );
  if (m) await db.exec(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [m.userId]);
}

export async function guardianAccountRoutes(app: FastifyInstance) {
  // Undangan dasbor orang tua. Bila nomor yang sama sudah punya akun wali di organisasi ini
  // (mis. kakak-adik), anak ini dihubungkan ke akun tersebut tanpa undangan baru.
  app.post('/guardians/:id/invite', async (req) => {
    const ctx = needTenant(req, 'guardian.invite');
    const id = idParam(req.params);
    const token = newToken();
    const result = await tenantTx(app, ctx, async (db) => {
      const g = await loadGuardian(db, ctx.orgId!, id);
      if (g.memberId) throw conflict('Wali ini sudah punya akun dasbor orang tua');
      const phone = normalizePhone(g.phone);
      if (!phone) throw badRequest('Isi nomor WhatsApp wali yang valid terlebih dahulu');

      const account = await db.maybe<{ id: string; status: string }>(
        `SELECT m.id, m.status FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = $1 AND m.role = 'wali' AND u.phone = $2 LIMIT 1`,
        [ctx.orgId, phone],
      );
      if (account) {
        await db.exec(`UPDATE guardians SET member_id = $3, updated_by = $4 WHERE organization_id = $1 AND id = $2`, [ctx.orgId, id, account.id, ctx.userId]);
        if (account.status !== 'active') {
          await db.exec(
            `UPDATE memberships SET status = 'active', deactivated_at = NULL, updated_by = $3 WHERE organization_id = $1 AND id = $2`,
            [ctx.orgId, account.id, ctx.userId],
          );
        }
        await audit(db, req, ctx, { action: 'wali.dihubungkan', entityType: 'patient', entityId: g.patientId, meta: { wali_id: id } });
        return { linked: true as const };
      }

      await db.exec(
        `UPDATE account_tokens SET revoked_at = now()
          WHERE organization_id = $1 AND guardian_id = $2 AND used_at IS NULL AND revoked_at IS NULL`,
        [ctx.orgId, id],
      );
      const t = await db.one<{ id: string; expiresAt: Date }>(
        `INSERT INTO account_tokens (organization_id, purpose, token_hash, phone, full_name, role, guardian_id, created_by, expires_at)
         VALUES ($1, 'undangan', $2, $3, $4, 'wali', $5, $6, now() + make_interval(hours => $7))
         RETURNING id, expires_at`,
        [ctx.orgId, sha256Hex(token), phone, g.fullName, id, ctx.userId, INVITE_HOURS],
      );
      await audit(db, req, ctx, { action: 'wali.diundang', entityType: 'patient', entityId: g.patientId, meta: { wali_id: id, undangan_id: t.id } });
      return { linked: false as const, expiresAt: t.expiresAt, phone };
    });
    // Token hanya ditampilkan sekali; yang disimpan hanya hash-nya.
    return result.linked ? result : { ...result, url: `${app.config.publicBaseUrl}/aktivasi#token=${token}` };
  });

  // Membatalkan undangan yang belum dipakai dan melepas anak ini dari akun walinya.
  app.post('/guardians/:id/revoke-access', async (req) => {
    const ctx = needTenant(req, 'guardian.invite');
    const id = idParam(req.params);
    await tenantTx(app, ctx, async (db) => {
      const g = await loadGuardian(db, ctx.orgId!, id);
      await db.exec(
        `UPDATE account_tokens SET revoked_at = now()
          WHERE organization_id = $1 AND guardian_id = $2 AND used_at IS NULL AND revoked_at IS NULL`,
        [ctx.orgId, id],
      );
      if (g.memberId) {
        await db.exec(`UPDATE guardians SET member_id = NULL, updated_by = $3 WHERE organization_id = $1 AND id = $2`, [ctx.orgId, id, ctx.userId]);
        await closeGuardianAccountIfUnlinked(db, ctx.orgId!, g.memberId, ctx.userId);
      }
      await audit(db, req, ctx, { action: 'wali.akses_dicabut', entityType: 'patient', entityId: g.patientId, meta: { wali_id: id } });
    });
    return { ok: true };
  });

  app.post('/guardians/:id/reset-link', async (req) => {
    const ctx = needTenant(req, 'guardian.invite');
    const id = idParam(req.params);
    const token = newToken();
    const result = await tenantTx(app, ctx, async (db) => {
      const g = await loadGuardian(db, ctx.orgId!, id);
      const u = g.memberId
        ? await db.maybe<{ userId: string; phone: string | null }>(
            `SELECT m.user_id, u.phone FROM memberships m JOIN users u ON u.id = m.user_id
              WHERE m.organization_id = $1 AND m.id = $2 AND m.role = 'wali' AND m.status = 'active'`,
            [ctx.orgId, g.memberId],
          )
        : null;
      if (!u) throw conflict('Wali ini belum punya akun aktif');
      await db.exec(
        `UPDATE account_tokens SET revoked_at = now()
          WHERE organization_id = $1 AND purpose = 'reset_sandi' AND user_id = $2 AND used_at IS NULL AND revoked_at IS NULL`,
        [ctx.orgId, u.userId],
      );
      const t = await db.one<{ expiresAt: Date }>(
        `INSERT INTO account_tokens (organization_id, purpose, token_hash, user_id, created_by, expires_at)
         VALUES ($1, 'reset_sandi', $2, $3, $4, now() + make_interval(hours => $5)) RETURNING expires_at`,
        [ctx.orgId, sha256Hex(token), u.userId, ctx.userId, RESET_HOURS],
      );
      await audit(db, req, ctx, { action: 'wali.tautan_reset_dibuat', entityType: 'patient', entityId: g.patientId, meta: { wali_id: id } });
      return { expiresAt: t.expiresAt, phone: normalizePhone(g.phone) ?? u.phone };
    });
    return { ...result, url: `${app.config.publicBaseUrl}/reset-sandi#token=${token}` };
  });
}
