import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { can, needTenant, tenantTx } from '../authz/context.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { idParam, parse, zDate, zMoney, zOptText, zRange } from '../http.ts';

const ruleBody = z
  .object({
    memberId: z.uuid(),
    serviceId: z.uuid().nullish(),
    scheme: z.enum(['tetap_per_sesi', 'persen_tarif']),
    amount: zMoney.nullish(),
    percent: z.number().gt(0).max(100).nullish(),
    effectiveFrom: zDate,
    effectiveTo: zDate.nullish(),
    notes: zOptText(500),
  })
  .refine((r) => (r.scheme === 'tetap_per_sesi' ? r.amount != null : r.percent != null), 'Isi nominal atau persentase sesuai skema')
  .refine((r) => !r.effectiveTo || r.effectiveTo >= r.effectiveFrom, 'Tanggal akhir harus setelah tanggal mulai');

export async function compensationRoutes(app: FastifyInstance) {
  const READ = ['compensation.read', 'compensation.read.own'] as const;

  app.get('/compensation/rules', async (req) => {
    const ctx = needTenant(req, ...READ);
    const own = !can(ctx, 'compensation.read');
    return tenantTx(app, ctx, (db) =>
      db.many(
        `SELECT r.id, r.member_id, u.full_name AS therapist_name, r.service_id, s.name AS service_name, r.scheme, r.amount, r.percent,
                r.effective_from, r.effective_to, r.notes, r.created_at
           FROM compensation_rules r
           JOIN memberships m ON m.organization_id = r.organization_id AND m.id = r.member_id
           JOIN users u ON u.id = m.user_id
           LEFT JOIN therapy_services s ON s.organization_id = r.organization_id AND s.id = r.service_id
          WHERE r.organization_id = $1 AND ($2::uuid IS NULL OR r.member_id = $2)
          ORDER BY u.full_name, r.effective_from DESC`,
        [ctx.orgId, own ? ctx.memberId : null],
      ),
    );
  });

  app.post('/compensation/rules', async (req, reply) => {
    const ctx = needTenant(req, 'compensation.manage');
    const body = parse(ruleBody, req.body);
    const row = await tenantTx(app, ctx, async (db) => {
      const member = await db.maybe(`SELECT 1 FROM memberships WHERE organization_id = $1 AND id = $2 AND is_therapist`, [ctx.orgId, body.memberId]);
      if (!member) throw badRequest('Terapis tidak valid');
      if (body.serviceId) {
        const s = await db.maybe(`SELECT 1 FROM therapy_services WHERE organization_id = $1 AND id = $2`, [ctx.orgId, body.serviceId]);
        if (!s) throw badRequest('Layanan tidak valid');
      }
      const overlap = await db.maybe(
        `SELECT 1 FROM compensation_rules
          WHERE organization_id = $1 AND member_id = $2 AND service_id IS NOT DISTINCT FROM $3
            AND daterange(effective_from, effective_to, '[]') && daterange($4::date, $5::date, '[]')`,
        [ctx.orgId, body.memberId, body.serviceId ?? null, body.effectiveFrom, body.effectiveTo ?? null],
      );
      if (overlap) throw conflict('Sudah ada aturan untuk terapis dan layanan ini pada periode yang tumpang tindih. Akhiri aturan lama terlebih dahulu.');
      const r = await db.one<{ id: string }>(
        `INSERT INTO compensation_rules (organization_id, member_id, service_id, scheme, amount, percent, effective_from, effective_to, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          ctx.orgId,
          body.memberId,
          body.serviceId ?? null,
          body.scheme,
          body.scheme === 'tetap_per_sesi' ? body.amount : null,
          body.scheme === 'persen_tarif' ? body.percent : null,
          body.effectiveFrom,
          body.effectiveTo ?? null,
          body.notes,
          ctx.userId,
        ],
      );
      await audit(db, req, ctx, { action: 'kompensasi.aturan_dibuat', entityType: 'compensation_rule', entityId: r.id, meta: { terapis: body.memberId, skema: body.scheme } });
      return r;
    });
    return reply.status(201).send(row);
  });

  app.post('/compensation/rules/:id/end', async (req) => {
    const ctx = needTenant(req, 'compensation.manage');
    const id = idParam(req.params);
    const { effectiveTo } = parse(z.object({ effectiveTo: zDate }), req.body);
    await tenantTx(app, ctx, async (db) => {
      const r = await db.maybe<{ effectiveFrom: string }>(`SELECT effective_from FROM compensation_rules WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [ctx.orgId, id]);
      if (!r) throw notFound('Aturan');
      if (effectiveTo < r.effectiveFrom) throw badRequest('Tanggal akhir sebelum tanggal mulai aturan');
      await db.exec(`UPDATE compensation_rules SET effective_to = $3 WHERE organization_id = $1 AND id = $2`, [ctx.orgId, id, effectiveTo]);
      await audit(db, req, ctx, { action: 'kompensasi.aturan_diakhiri', entityType: 'compensation_rule', entityId: id, meta: { berakhir: effectiveTo } });
    });
    return { ok: true };
  });

  app.get('/compensation', async (req) => {
    const ctx = needTenant(req, ...READ);
    const q = parse(zRange.and(z.object({ memberId: z.uuid().optional(), status: z.enum(['dihitung', 'dibayar', 'dibatalkan']).optional() })), req.query);
    const own = !can(ctx, 'compensation.read');
    return tenantTx(app, ctx, async (db) => {
      const items = await db.many(
        `SELECT c.id, c.member_id, u.full_name AS therapist_name, c.appointment_id, c.session_date, c.amount, c.status, c.paid_on, c.basis,
                p.full_name AS patient_name, p.patient_code, s.name AS service_name
           FROM therapist_compensations c
           JOIN memberships m ON m.organization_id = c.organization_id AND m.id = c.member_id
           JOIN users u ON u.id = m.user_id
           JOIN appointments a ON a.organization_id = c.organization_id AND a.id = c.appointment_id
           LEFT JOIN patients p ON p.organization_id = a.organization_id AND p.id = a.patient_id
           LEFT JOIN therapy_services s ON s.organization_id = a.organization_id AND s.id = a.service_id
          WHERE c.organization_id = $1 AND c.session_date BETWEEN $2 AND $3
            AND ($4::uuid IS NULL OR c.member_id = $4)
            AND ($5::text IS NULL OR c.status = $5)
          ORDER BY u.full_name, c.session_date`,
        [ctx.orgId, q.from, q.to, own ? ctx.memberId : (q.memberId ?? null), q.status ?? null],
      );
      const summary = await db.many(
        `SELECT c.member_id, u.full_name AS therapist_name,
                count(*) FILTER (WHERE c.status <> 'dibatalkan') AS sessions,
                coalesce(sum(c.amount) FILTER (WHERE c.status = 'dihitung'), 0) AS unpaid,
                coalesce(sum(c.amount) FILTER (WHERE c.status = 'dibayar'), 0) AS paid
           FROM therapist_compensations c
           JOIN memberships m ON m.organization_id = c.organization_id AND m.id = c.member_id
           JOIN users u ON u.id = m.user_id
          WHERE c.organization_id = $1 AND c.session_date BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR c.member_id = $4)
          GROUP BY c.member_id, u.full_name ORDER BY u.full_name`,
        [ctx.orgId, q.from, q.to, own ? ctx.memberId : (q.memberId ?? null)],
      );
      return { items, summary };
    });
  });

  app.post('/compensation/mark-paid', async (req) => {
    const ctx = needTenant(req, 'compensation.manage');
    const body = parse(z.object({ ids: z.array(z.uuid()).min(1).max(500), paidOn: zDate }), req.body);
    return tenantTx(app, ctx, async (db) => {
      const n = await db.exec(
        `UPDATE therapist_compensations SET status = 'dibayar', paid_on = $3, updated_by = $4
          WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND status = 'dihitung'`,
        [ctx.orgId, body.ids, body.paidOn, ctx.userId],
      );
      await audit(db, req, ctx, { action: 'kompensasi.ditandai_dibayar', entityType: 'compensation', meta: { jumlah: n, tanggal: body.paidOn } });
      return { updated: n };
    });
  });
}
