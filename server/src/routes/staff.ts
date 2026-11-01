import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { needTenant, tenantTx } from '../authz/context.ts';
import { roleLabel, type Role } from '../authz/permissions.ts';
import type { Db } from '../db.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { idParam, parse, zOptText, zText } from '../http.ts';
import { newToken, sha256Hex } from '../security/tokens.ts';
import { normalizePhone } from './reminders.ts';

const INVITE_HOURS = 72;
const RESET_HOURS = 24;

// Peran yang boleh diberikan owner. 'owner' sengaja tidak ada.
const assignableRole = z.enum(['admin', 'terapis', 'keuangan']);

const inviteBody = z.object({
  // Nomor WhatsApp tujuan undangan. Staf memilih username sendiri saat aktivasi.
  phone: zText(8, 40),
  fullName: zText(2, 150),
  role: assignableRole,
  isTherapist: z.boolean().default(false),
  // Hanya untuk admin: merangkap keuangan/kasir (keputusan owner per admin).
  handlesFinance: z.boolean().default(false),
  specialization: zOptText(120),
});

const memberPatch = z.object({
  role: assignableRole.optional(),
  isTherapist: z.boolean().optional(),
  handlesFinance: z.boolean().optional(),
  specialization: zOptText(120).optional(),
});

const ONLY_ADMIN_FINANCE = 'Hanya peran admin yang dapat merangkap keuangan';

interface MemberRow {
  id: string;
  userId: string;
  role: Role;
  status: string;
  isTherapist: boolean;
  handlesFinance: boolean;
}

async function loadEditableMember(db: Db, orgId: string, memberId: string, selfMemberId: string | null): Promise<MemberRow> {
  const m = await db.maybe<MemberRow>(
    `SELECT id, user_id, role, status, is_therapist, handles_finance FROM memberships WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
    [orgId, memberId],
  );
  // Akun wali dikelola dari data wali di halaman pasien, bukan sebagai staf.
  if (!m || m.role === 'wali') throw notFound('Staf');
  if (m.id === selfMemberId) throw forbidden('Anda tidak dapat mengubah akses akun Anda sendiri');
  if (m.role === 'owner') throw forbidden('Akun owner hanya dapat diubah melalui prosedur administrasi');
  return m;
}

export async function staffRoutes(app: FastifyInstance) {
  app.get('/staff', async (req) => {
    const ctx = needTenant(req, 'staff.read');
    const rows = await tenantTx(app, ctx, (db) =>
      db.many<{ role: Role; handlesFinance: boolean }>(
        `SELECT m.id, m.user_id, u.full_name, u.email, u.username, u.phone, m.role, m.status, m.is_therapist, m.handles_finance, m.specialization,
                m.created_at, m.deactivated_at, u.last_login_at
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = $1 AND m.role <> 'wali'
          ORDER BY m.status, CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'terapis' THEN 2 ELSE 3 END, u.full_name`,
        [ctx.orgId],
      ),
    );
    return rows.map((r) => ({ ...r, roleLabel: roleLabel(r.role, r.handlesFinance) }));
  });

  // Direktori terapis aktif (untuk formulir jadwal / penugasan).
  app.get('/staff/therapists', async (req) => {
    const ctx = needTenant(req, 'org.read');
    return tenantTx(app, ctx, (db) =>
      db.many(
        `SELECT m.id, u.full_name, m.specialization
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = $1 AND m.status = 'active' AND m.is_therapist
          ORDER BY u.full_name`,
        [ctx.orgId],
      ),
    );
  });

  app.get('/staff/invitations', async (req) => {
    const ctx = needTenant(req, 'staff.manage');
    return tenantTx(app, ctx, (db) =>
      db.many(
        `SELECT t.id, t.email, t.phone, t.full_name, t.role, t.is_therapist, t.handles_finance, t.specialization, t.expires_at, t.used_at, t.revoked_at, t.created_at,
                CASE WHEN t.used_at IS NOT NULL THEN 'dipakai'
                     WHEN t.revoked_at IS NOT NULL THEN 'dibatalkan'
                     WHEN t.expires_at <= now() THEN 'kedaluwarsa'
                     ELSE 'menunggu' END AS state
           FROM account_tokens t
          WHERE t.organization_id = $1 AND t.purpose = 'undangan' AND t.role <> 'wali'
          ORDER BY t.created_at DESC LIMIT 100`,
        [ctx.orgId],
      ),
    );
  });

  app.post('/staff/invitations', async (req, reply) => {
    const ctx = needTenant(req, 'staff.manage');
    const body = parse(inviteBody, req.body);
    if (body.handlesFinance && body.role !== 'admin') throw badRequest(ONLY_ADMIN_FINANCE);
    const phone = normalizePhone(body.phone);
    if (!phone) throw badRequest('Nomor WhatsApp tidak valid. Contoh: 081234567890');
    const token = newToken();
    const result = await tenantTx(app, ctx, async (db) => {
      // Hanya memeriksa staf organisasi sendiri; keberadaan akun di organisasi lain tidak terlihat.
      const already = await db.maybe(
        `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 AND m.role <> 'wali' AND u.phone = $2`,
        [ctx.orgId, phone],
      );
      if (already) throw conflict('Nomor ini sudah terdaftar sebagai staf organisasi Anda');
      await db.exec(
        `UPDATE account_tokens SET revoked_at = now()
          WHERE organization_id = $1 AND purpose = 'undangan' AND role <> 'wali' AND phone = $2 AND used_at IS NULL AND revoked_at IS NULL`,
        [ctx.orgId, phone],
      );
      const t = await db.one<{ id: string; expiresAt: Date }>(
        `INSERT INTO account_tokens
           (organization_id, purpose, token_hash, phone, full_name, role, is_therapist, handles_finance, specialization, created_by, expires_at)
         VALUES ($1, 'undangan', $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(hours => $10))
         RETURNING id, expires_at`,
        [
          ctx.orgId,
          sha256Hex(token),
          phone,
          body.fullName,
          body.role,
          body.isTherapist || body.role === 'terapis',
          body.handlesFinance,
          body.specialization,
          ctx.userId,
          INVITE_HOURS,
        ],
      );
      await audit(db, req, ctx, { action: 'staf.diundang', entityType: 'invitation', entityId: t.id, meta: { peran: body.role, merangkap_keuangan: body.handlesFinance } });
      return t;
    });
    // Token hanya ditampilkan sekali; yang disimpan hanya hash-nya.
    return reply.status(201).send({
      id: result.id,
      expiresAt: result.expiresAt,
      phone,
      url: `${app.config.publicBaseUrl}/aktivasi#token=${token}`,
    });
  });

  app.post('/staff/invitations/:id/revoke', async (req) => {
    const ctx = needTenant(req, 'staff.manage');
    const id = idParam(req.params);
    await tenantTx(app, ctx, async (db) => {
      const n = await db.exec(
        `UPDATE account_tokens SET revoked_at = now()
          WHERE organization_id = $1 AND id = $2 AND purpose = 'undangan' AND used_at IS NULL AND revoked_at IS NULL`,
        [ctx.orgId, id],
      );
      if (n === 0) throw notFound('Undangan');
      await audit(db, req, ctx, { action: 'staf.undangan_dibatalkan', entityType: 'invitation', entityId: id });
    });
    return { ok: true };
  });

  app.patch('/staff/:id', async (req) => {
    const ctx = needTenant(req, 'staff.manage');
    const id = idParam(req.params);
    const patch = parse(memberPatch, req.body);
    return tenantTx(app, ctx, async (db) => {
      const m = await loadEditableMember(db, ctx.orgId!, id, ctx.memberId);
      const role = patch.role ?? m.role;
      const isTherapist = role === 'terapis' ? true : (patch.isTherapist ?? m.isTherapist);
      if (patch.handlesFinance && role !== 'admin') throw badRequest(ONLY_ADMIN_FINANCE);
      // Pindah dari admin ke peran lain otomatis melepas rangkap keuangan.
      const handlesFinance = role === 'admin' ? (patch.handlesFinance ?? m.handlesFinance) : false;
      await db.exec(
        `UPDATE memberships SET role = $3, is_therapist = $4, handles_finance = $5,
                specialization = CASE WHEN $6::boolean THEN $7 ELSE specialization END, updated_by = $8
          WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, role, isTherapist, handlesFinance, patch.specialization !== undefined, patch.specialization ?? null, ctx.userId],
      );
      await audit(db, req, ctx, {
        action: 'staf.diubah',
        entityType: 'membership',
        entityId: id,
        meta: {
          peran_sebelum: m.role,
          peran_sesudah: role,
          terapis: isTherapist,
          keuangan_sebelum: m.handlesFinance,
          keuangan_sesudah: handlesFinance,
        },
      });
      return { ok: true };
    });
  });

  app.post('/staff/:id/deactivate', async (req) => {
    const ctx = needTenant(req, 'staff.manage');
    const id = idParam(req.params);
    await tenantTx(app, ctx, async (db) => {
      const m = await loadEditableMember(db, ctx.orgId!, id, ctx.memberId);
      if (m.status === 'inactive') return;
      await db.exec(
        `UPDATE memberships SET status = 'inactive', deactivated_at = now(), updated_by = $3 WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, ctx.userId],
      );
      // Semua sesi login staf tersebut langsung dicabut.
      const sessions = await db.exec(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [m.userId]);
      await audit(db, req, ctx, { action: 'staf.dinonaktifkan', entityType: 'membership', entityId: id, meta: { sesi_dicabut: sessions } });
    });
    return { ok: true };
  });

  app.post('/staff/:id/reactivate', async (req) => {
    const ctx = needTenant(req, 'staff.manage');
    const id = idParam(req.params);
    await tenantTx(app, ctx, async (db) => {
      const m = await loadEditableMember(db, ctx.orgId!, id, ctx.memberId);
      if (m.status === 'active') return;
      await db.exec(
        `UPDATE memberships SET status = 'active', deactivated_at = NULL, updated_by = $3 WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, ctx.userId],
      );
      await audit(db, req, ctx, { action: 'staf.diaktifkan', entityType: 'membership', entityId: id });
    });
    return { ok: true };
  });

  app.post('/staff/:id/reset-link', async (req) => {
    const ctx = needTenant(req, 'staff.manage');
    const id = idParam(req.params);
    const token = newToken();
    const t = await tenantTx(app, ctx, async (db) => {
      const m = await loadEditableMember(db, ctx.orgId!, id, ctx.memberId);
      if (m.status !== 'active') throw conflict('Aktifkan kembali staf sebelum membuat tautan reset');
      const u = await db.one<{ email: string | null; phone: string | null }>(`SELECT email, phone FROM users WHERE id = $1`, [m.userId]);
      await db.exec(
        `UPDATE account_tokens SET revoked_at = now()
          WHERE organization_id = $1 AND purpose = 'reset_sandi' AND user_id = $2 AND used_at IS NULL AND revoked_at IS NULL`,
        [ctx.orgId, m.userId],
      );
      const row = await db.one<{ id: string; expiresAt: Date }>(
        `INSERT INTO account_tokens (organization_id, purpose, token_hash, email, user_id, created_by, expires_at)
         VALUES ($1, 'reset_sandi', $2, $3, $4, $5, now() + make_interval(hours => $6)) RETURNING id, expires_at`,
        [ctx.orgId, sha256Hex(token), u.email, m.userId, ctx.userId, RESET_HOURS],
      );
      await audit(db, req, ctx, { action: 'staf.tautan_reset_dibuat', entityType: 'membership', entityId: id });
      return { ...row, phone: u.phone };
    });
    return { expiresAt: t.expiresAt, phone: t.phone, url: `${app.config.publicBaseUrl}/reset-sandi#token=${token}` };
  });
}
