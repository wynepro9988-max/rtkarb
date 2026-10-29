import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, writeAudit } from '../audit.ts';
import { needAuth, needPlatform, needTenant, platformTx, tenantTx } from '../authz/context.ts';
import { SUPPORT_SCOPES } from '../authz/permissions.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { idParam, parse, zOptText, zText } from '../http.ts';

const GRANT_FIELDS = `g.id, g.organization_id, g.requested_by_name, g.reason, g.scopes, g.duration_minutes, g.status,
  g.decided_at, g.decision_note, g.starts_at, g.expires_at, g.revoked_at, g.created_at,
  CASE WHEN g.status = 'disetujui' AND g.revoked_at IS NULL AND now() >= g.starts_at AND now() < g.expires_at THEN 'aktif'
       WHEN g.status = 'disetujui' AND now() >= g.expires_at THEN 'kedaluwarsa'
       ELSE g.status END AS state`;

// Data jadwal, paket, catatan, berkas, keuangan, dan laporan hanya terlihat bila pasiennya
// terlihat (RLS). Cakupan tersebut wajib disertai patient.read secara eksplisit agar owner
// melihat persis apa yang ia setujui.
const STANDALONE_SCOPES = new Set<string>(['staff.read', 'audit.read']);

const requestBody = z
  .object({
    organizationId: z.uuid(),
    reason: zText(10, 1000),
    scopes: z.array(z.enum(SUPPORT_SCOPES)).min(1).max(SUPPORT_SCOPES.length),
    durationMinutes: z.number().int().min(15).max(480),
  })
  .refine((b) => b.scopes.every((s) => STANDALONE_SCOPES.has(s)) || b.scopes.includes('patient.read'), {
    message: 'Cakupan yang dipilih memerlukan cakupan patient.read (data administratif pasien)',
    path: ['scopes'],
  });

export async function supportRoutes(app: FastifyInstance) {
  // ---------- Sisi owner organisasi ----------
  app.get('/support/requests', async (req) => {
    const ctx = needTenant(req, 'support.approve');
    if (ctx.mode !== 'tenant') throw forbidden();
    return tenantTx(app, ctx, (db) =>
      db.many(`SELECT ${GRANT_FIELDS} FROM support_access_grants g WHERE g.organization_id = $1 ORDER BY g.created_at DESC LIMIT 100`, [ctx.orgId]),
    );
  });

  const decide = (decision: 'approve' | 'reject') => async (req: import('fastify').FastifyRequest) => {
    const ctx = needTenant(req, 'support.approve');
    if (ctx.mode !== 'tenant') throw forbidden();
    const id = idParam(req.params);
    const { note } = parse(z.object({ note: zOptText(1000) }), req.body ?? {});
    return tenantTx(app, ctx, async (db) => {
      const g = await db.maybe<{ status: string; durationMinutes: number }>(
        `SELECT status, duration_minutes FROM support_access_grants WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [ctx.orgId, id],
      );
      if (!g) throw notFound('Permintaan akses');
      if (g.status !== 'menunggu') throw conflict('Permintaan ini sudah diputuskan');
      if (decision === 'approve') {
        await db.exec(
          `UPDATE support_access_grants
              SET status = 'disetujui', decided_by = $3, decided_at = now(), decision_note = $4,
                  starts_at = now(), expires_at = now() + make_interval(mins => duration_minutes)
            WHERE organization_id = $1 AND id = $2`,
          [ctx.orgId, id, ctx.userId, note],
        );
      } else {
        await db.exec(
          `UPDATE support_access_grants SET status = 'ditolak', decided_by = $3, decided_at = now(), decision_note = $4
            WHERE organization_id = $1 AND id = $2`,
          [ctx.orgId, id, ctx.userId, note],
        );
      }
      await audit(db, req, ctx, {
        action: decision === 'approve' ? 'dukungan.disetujui' : 'dukungan.ditolak',
        entityType: 'support_grant',
        entityId: id,
      });
      return db.one(`SELECT ${GRANT_FIELDS} FROM support_access_grants g WHERE g.organization_id = $1 AND g.id = $2`, [ctx.orgId, id]);
    });
  };
  app.post('/support/requests/:id/approve', decide('approve'));
  app.post('/support/requests/:id/reject', decide('reject'));

  app.post('/support/requests/:id/revoke', async (req) => {
    const ctx = needTenant(req, 'support.approve');
    if (ctx.mode !== 'tenant') throw forbidden();
    const id = idParam(req.params);
    await tenantTx(app, ctx, async (db) => {
      const n = await db.exec(
        `UPDATE support_access_grants SET status = 'dicabut', revoked_by = $3, revoked_at = now()
          WHERE organization_id = $1 AND id = $2 AND status = 'disetujui' AND revoked_at IS NULL`,
        [ctx.orgId, id, ctx.userId],
      );
      if (n === 0) throw conflict('Akses ini tidak sedang berlaku');
      // Sesi admin teknis yang sedang memakai akses ini langsung keluar dari mode dukungan.
      await db.exec(`UPDATE sessions SET support_grant_id = NULL, organization_id = NULL WHERE support_grant_id = $1`, [id]);
      await audit(db, req, ctx, { action: 'dukungan.dicabut', entityType: 'support_grant', entityId: id });
    });
    return { ok: true };
  });

  // ---------- Sisi admin teknis platform ----------
  app.get('/platform/organizations', async (req) => {
    const ctx = needPlatform(req);
    // Hanya metadata organisasi; tidak ada data operasional.
    return platformTx(app, ctx, (db) => db.many(`SELECT id, name, status, created_at FROM organizations ORDER BY name`));
  });

  // Kapasitas (angka agregat saja) dibanding batas paket penyedia database & penyimpanan.
  app.get('/platform/usage', async (req) => {
    const ctx = needPlatform(req);
    const rows = await platformTx(app, ctx, (db) =>
      db.many<{ orgId: string; orgName: string; storageBytes: number; patientCount: number; noteCount: number; auditRows: number; dbBytes: number }>(
        `SELECT * FROM platform_usage()`,
      ),
    );
    const storageBytes = rows.reduce((n, r) => n + r.storageBytes, 0);
    return {
      database: { usedBytes: rows[0]?.dbBytes ?? 0, limitBytes: app.config.dbSizeLimitBytes },
      storage: { usedBytes: storageBytes, limitBytes: app.config.storageLimitBytes, orgQuotaBytes: app.config.orgStorageQuotaBytes },
      organizations: rows.map(({ dbBytes: _d, ...r }) => r),
    };
  });

  app.get('/platform/support-requests', async (req) => {
    const ctx = needPlatform(req);
    return platformTx(app, ctx, (db) =>
      db.many(
        `SELECT ${GRANT_FIELDS}, o.name AS organization_name
           FROM support_access_grants g JOIN organizations o ON o.id = g.organization_id
          WHERE g.requested_by = $1 ORDER BY g.created_at DESC LIMIT 100`,
        [ctx.userId],
      ),
    );
  });

  app.post('/platform/support-requests', async (req, reply) => {
    const ctx = needPlatform(req);
    const body = parse(requestBody, req.body);
    const row = await platformTx(app, ctx, async (db) => {
      const org = await db.maybe(`SELECT 1 FROM organizations WHERE id = $1 AND status = 'active'`, [body.organizationId]);
      if (!org) throw badRequest('Organisasi tidak ditemukan');
      const g = await db.one<{ id: string }>(
        `INSERT INTO support_access_grants (organization_id, requested_by, requested_by_name, reason, scopes, duration_minutes)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [body.organizationId, ctx.userId, ctx.fullName, body.reason, [...new Set(body.scopes)], body.durationMinutes],
      );
      await writeAudit(db, req, { orgId: body.organizationId, userId: ctx.userId }, {
        action: 'dukungan.diminta',
        entityType: 'support_grant',
        entityId: g.id,
        meta: { cakupan: body.scopes, durasi_menit: body.durationMinutes },
      });
      return g;
    });
    return reply.status(201).send(row);
  });

  app.post('/platform/support-requests/:id/enter', async (req) => {
    const ctx = needPlatform(req);
    const id = idParam(req.params);
    await platformTx(app, ctx, async (db) => {
      const g = await db.maybe<{ organizationId: string }>(
        `SELECT organization_id FROM support_access_grants
          WHERE id = $1 AND requested_by = $2 AND status = 'disetujui' AND revoked_at IS NULL
            AND now() >= starts_at AND now() < expires_at`,
        [id, ctx.userId],
      );
      if (!g) throw forbidden('Akses dukungan ini belum disetujui, sudah dicabut, atau sudah kedaluwarsa');
      await db.exec(`UPDATE sessions SET support_grant_id = $2, organization_id = $3 WHERE id = $1`, [ctx.sessionId, id, g.organizationId]);
      await writeAudit(db, req, { orgId: g.organizationId, userId: ctx.userId, supportGrantId: id }, {
        action: 'dukungan.masuk',
        entityType: 'support_grant',
        entityId: id,
      });
    });
    return { ok: true };
  });

  app.post('/platform/support/exit', async (req) => {
    const ctx = needAuth(req);
    if (ctx.mode !== 'support' || !ctx.support) throw badRequest('Anda tidak sedang dalam mode dukungan');
    const grantId = ctx.support.grantId;
    await platformTx(app, ctx, async (db) => {
      await db.exec(`UPDATE sessions SET support_grant_id = NULL, organization_id = NULL WHERE id = $1`, [ctx.sessionId]);
      await writeAudit(db, req, { orgId: ctx.orgId, userId: ctx.userId, supportGrantId: grantId }, {
        action: 'dukungan.keluar',
        entityType: 'support_grant',
        entityId: grantId,
      });
    });
    return { ok: true };
  });
}
