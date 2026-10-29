import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { needTenant, tenantTx } from '../authz/context.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { idParam, parse, zDate, zText } from '../http.ts';
import { requirePatient } from './patients.ts';

export async function packageRoutes(app: FastifyInstance) {
  app.post('/patients/:id/packages', async (req, reply) => {
    const ctx = needTenant(req, 'package.sell');
    const patientId = idParam(req.params);
    const body = parse(z.object({ packageTypeId: z.uuid(), purchasedOn: zDate.optional() }), req.body);
    const created = await tenantTx(app, ctx, async (db) => {
      const patient = await requirePatient(db, ctx.orgId!, patientId);
      if (patient.status !== 'aktif') throw badRequest('Pasien tidak berstatus aktif');
      const pt = await db.maybe<{ id: string; name: string; serviceId: string | null; sessionsTotal: number; price: number; validDays: number | null }>(
        `SELECT id, name, service_id, sessions_total, price, valid_days FROM package_types WHERE organization_id = $1 AND id = $2 AND active`,
        [ctx.orgId, body.packageTypeId],
      );
      if (!pt) throw badRequest('Jenis paket tidak valid atau tidak aktif');
      const row = await db.one<{ id: string }>(
        `INSERT INTO patient_packages
           (organization_id, patient_id, package_type_id, service_id, name, sessions_total, price, purchased_on, expires_on, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7,
                 coalesce($8::date, (now() AT TIME ZONE $11)::date),
                 CASE WHEN $9::int IS NULL THEN NULL ELSE coalesce($8::date, (now() AT TIME ZONE $11)::date) + $9::int END,
                 $10, $10)
         RETURNING id`,
        [ctx.orgId, patientId, pt.id, pt.serviceId, pt.name, pt.sessionsTotal, pt.price, body.purchasedOn ?? null, pt.validDays, ctx.userId, ctx.timezone],
      );
      await audit(db, req, ctx, {
        action: 'paket.dijual',
        entityType: 'patient_package',
        entityId: row.id,
        meta: { pasien_id: patientId, jenis_paket_id: pt.id, sesi: pt.sessionsTotal, harga: pt.price },
      });
      return row;
    });
    return reply.status(201).send(created);
  });

  app.get('/patient-packages/:id', async (req) => {
    const ctx = needTenant(req, 'package.read');
    const id = idParam(req.params);
    return tenantTx(app, ctx, async (db) => {
      const pkg = await db.maybe(
        `SELECT pp.id, pp.patient_id, p.full_name AS patient_name, p.patient_code, pp.name, pp.sessions_total, pp.sessions_used,
                pp.sessions_total - pp.sessions_used AS sessions_remaining, pp.price, pp.purchased_on, pp.expires_on, pp.status, pp.cancel_reason
           FROM patient_packages pp JOIN patients p ON p.organization_id = pp.organization_id AND p.id = pp.patient_id
          WHERE pp.organization_id = $1 AND pp.id = $2`,
        [ctx.orgId, id],
      );
      if (!pkg) throw notFound('Paket');
      const ledger = await db.many(
        `SELECT l.id, l.kind, l.sessions_delta, l.sessions_used_after, l.reason, l.created_at, l.appointment_id,
                to_char(a.starts_at AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') AS session_at,
                u.full_name AS actor_name
           FROM package_ledger l
           LEFT JOIN appointments a ON a.organization_id = l.organization_id AND a.id = l.appointment_id
           LEFT JOIN users u ON u.id = l.created_by
          WHERE l.organization_id = $1 AND l.patient_package_id = $2
          ORDER BY l.created_at`,
        [ctx.orgId, id, ctx.timezone],
      );
      return { ...pkg, ledger };
    });
  });

  // Penyesuaian manual saldo (mis. koreksi data awal). delta > 0 = sesi dianggap terpakai,
  // delta < 0 = sesi dikembalikan. Database menolak saldo di luar 0..total.
  app.post('/patient-packages/:id/adjust', async (req) => {
    const ctx = needTenant(req, 'package.adjust');
    const id = idParam(req.params);
    const body = parse(
      z.object({ sessionsDelta: z.number().int().min(-100).max(100).refine((v) => v !== 0, 'Tidak boleh 0'), reason: zText(5, 500) }),
      req.body,
    );
    return tenantTx(app, ctx, async (db) => {
      const pkg = await db.maybe<{ patientId: string; sessionsUsed: number; sessionsTotal: number; status: string }>(
        `SELECT patient_id, sessions_used, sessions_total, status FROM patient_packages WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [ctx.orgId, id],
      );
      if (!pkg) throw notFound('Paket');
      if (pkg.status === 'dibatalkan') throw conflict('Paket yang dibatalkan tidak dapat disesuaikan');
      const used = pkg.sessionsUsed + body.sessionsDelta;
      if (used < 0 || used > pkg.sessionsTotal) throw conflict('Penyesuaian membuat saldo sesi di luar batas paket');
      await db.exec(
        `UPDATE patient_packages SET sessions_used = $3, status = CASE WHEN $3 = sessions_total THEN 'selesai' ELSE 'aktif' END, updated_by = $4
          WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, used, ctx.userId],
      );
      await db.exec(
        `INSERT INTO package_ledger (organization_id, patient_id, patient_package_id, kind, sessions_delta, sessions_used_after, reason, created_by)
         VALUES ($1, $2, $3, 'penyesuaian', $4, $5, $6, $7)`,
        [ctx.orgId, pkg.patientId, id, body.sessionsDelta, used, body.reason, ctx.userId],
      );
      await audit(db, req, ctx, { action: 'paket.disesuaikan', entityType: 'patient_package', entityId: id, meta: { delta: body.sessionsDelta, terpakai: used } });
      return { sessionsUsed: used, sessionsRemaining: pkg.sessionsTotal - used };
    });
  });

  app.post('/patient-packages/:id/cancel', async (req) => {
    const ctx = needTenant(req, 'package.adjust');
    const id = idParam(req.params);
    const { reason } = parse(z.object({ reason: zText(5, 500) }), req.body);
    await tenantTx(app, ctx, async (db) => {
      const pkg = await db.maybe<{ status: string }>(`SELECT status FROM patient_packages WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [ctx.orgId, id]);
      if (!pkg) throw notFound('Paket');
      if (pkg.status === 'dibatalkan') return;
      const pending = await db.maybe(
        `SELECT 1 FROM appointments WHERE organization_id = $1 AND patient_package_id = $2 AND status = 'terjadwal' LIMIT 1`,
        [ctx.orgId, id],
      );
      if (pending) throw conflict('Masih ada jadwal terjadwal yang memakai paket ini. Batalkan atau ubah jadwal tersebut dahulu.');
      await db.exec(
        `UPDATE patient_packages SET status = 'dibatalkan', cancel_reason = $3, updated_by = $4 WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, reason, ctx.userId],
      );
      await audit(db, req, ctx, { action: 'paket.dibatalkan', entityType: 'patient_package', entityId: id });
    });
    return { ok: true };
  });
}
