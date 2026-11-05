import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { can, needTenant, tenantTx } from '../authz/context.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { idParam, parse, zDate, zMoney, zOptText, zPositiveMoney, zRange, zText } from '../http.ts';

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

// Bulan kalender "YYYY-MM"; disimpan sebagai tanggal 1.
const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Format bulan harus YYYY-MM');
const monthStart = (m: string) => `${m}-01`;

const componentBody = z
  .object({
    memberId: z.uuid(),
    kind: z.enum(['gaji_pokok', 'tunjangan']),
    name: zText(2, 80),
    amount: zPositiveMoney,
    startMonth: zMonth,
    endMonth: zMonth.nullish(),
    notes: zOptText(500),
  })
  .refine((c) => !c.endMonth || c.endMonth >= c.startMonth, 'Bulan akhir harus sama atau setelah bulan mulai');

// Komponen bulanan berlaku pada bulan `period` (tanggal 1); `c` = compensation_components.
const activeIn = (period: string) => `c.start_month <= ${period} AND (c.end_month IS NULL OR c.end_month >= ${period})`;

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

  // ---- Gaji pokok & tunjangan (komponen bulanan) ----

  app.get('/compensation/components', async (req) => {
    const ctx = needTenant(req, ...READ);
    const own = !can(ctx, 'compensation.read');
    return tenantTx(app, ctx, (db) =>
      db.many(
        `SELECT c.id, c.member_id, u.full_name AS therapist_name, c.kind, c.name, c.amount,
                to_char(c.start_month, 'YYYY-MM') AS start_month, to_char(c.end_month, 'YYYY-MM') AS end_month, c.notes,
                (SELECT to_char(max(po.period), 'YYYY-MM') FROM compensation_component_payouts po
                  WHERE po.organization_id = c.organization_id AND po.component_id = c.id) AS last_paid_month
           FROM compensation_components c
           JOIN memberships m ON m.organization_id = c.organization_id AND m.id = c.member_id
           JOIN users u ON u.id = m.user_id
          WHERE c.organization_id = $1 AND ($2::uuid IS NULL OR c.member_id = $2)
          ORDER BY u.full_name, c.kind, c.start_month DESC, c.name`,
        [ctx.orgId, own ? ctx.memberId : null],
      ),
    );
  });

  app.post('/compensation/components', async (req, reply) => {
    const ctx = needTenant(req, 'compensation.manage');
    const body = parse(componentBody, req.body);
    const row = await tenantTx(app, ctx, async (db) => {
      // Mengunci keanggotaan agar dua gaji pokok tidak lolos bersamaan.
      const member = await db.maybe(
        `SELECT 1 FROM memberships WHERE organization_id = $1 AND id = $2 AND is_therapist AND role <> 'wali' FOR UPDATE`,
        [ctx.orgId, body.memberId],
      );
      if (!member) throw badRequest('Terapis tidak valid');
      if (body.kind === 'gaji_pokok') {
        const overlap = await db.maybe(
          `SELECT 1 FROM compensation_components
            WHERE organization_id = $1 AND member_id = $2 AND kind = 'gaji_pokok'
              AND start_month <= coalesce($4::date, 'infinity') AND coalesce(end_month, 'infinity') >= $3::date`,
          [ctx.orgId, body.memberId, monthStart(body.startMonth), body.endMonth ? monthStart(body.endMonth) : null],
        );
        if (overlap) throw conflict('Terapis ini sudah punya gaji pokok pada bulan yang tumpang tindih. Akhiri gaji pokok lama terlebih dahulu.');
      }
      const c = await db.one<{ id: string }>(
        `INSERT INTO compensation_components (organization_id, member_id, kind, name, amount, start_month, end_month, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [
          ctx.orgId,
          body.memberId,
          body.kind,
          body.name,
          body.amount,
          monthStart(body.startMonth),
          body.endMonth ? monthStart(body.endMonth) : null,
          body.notes,
          ctx.userId,
        ],
      );
      await audit(db, req, ctx, {
        action: 'kompensasi.komponen_dibuat',
        entityType: 'compensation_component',
        entityId: c.id,
        meta: { terapis: body.memberId, jenis: body.kind, nominal: body.amount, mulai: body.startMonth },
      });
      return c;
    });
    return reply.status(201).send(row);
  });

  app.post('/compensation/components/:id/end', async (req) => {
    const ctx = needTenant(req, 'compensation.manage');
    const id = idParam(req.params);
    const { endMonth } = parse(z.object({ endMonth: zMonth }), req.body);
    await tenantTx(app, ctx, async (db) => {
      const c = await db.maybe<{ startMonth: string; lastPaid: string | null }>(
        `SELECT to_char(start_month, 'YYYY-MM') AS start_month,
                (SELECT to_char(max(period), 'YYYY-MM') FROM compensation_component_payouts po
                  WHERE po.organization_id = c.organization_id AND po.component_id = c.id) AS last_paid
           FROM compensation_components c WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [ctx.orgId, id],
      );
      if (!c) throw notFound('Komponen');
      if (endMonth < c.startMonth) throw badRequest('Bulan akhir sebelum bulan mulai komponen');
      if (c.lastPaid && endMonth < c.lastPaid) throw badRequest(`Komponen ini sudah dibayar sampai ${c.lastPaid}; bulan akhir tidak boleh lebih awal`);
      await db.exec(`UPDATE compensation_components SET end_month = $3 WHERE organization_id = $1 AND id = $2`, [ctx.orgId, id, monthStart(endMonth)]);
      await audit(db, req, ctx, { action: 'kompensasi.komponen_diakhiri', entityType: 'compensation_component', entityId: id, meta: { berakhir: endMonth } });
    });
    return { ok: true };
  });

  // Rekap satu bulan per terapis: gaji pokok & tunjangan yang berlaku + honor per sesi bulan itu.
  app.get('/compensation/monthly', async (req) => {
    const ctx = needTenant(req, ...READ);
    const { month } = parse(z.object({ month: zMonth }), req.query);
    const own = !can(ctx, 'compensation.read');
    const period = monthStart(month);
    return tenantTx(app, ctx, async (db) => {
      const fixed = await db.many<{ componentId: string; memberId: string; kind: string; name: string; amount: number; paidOn: string | null }>(
        `SELECT c.id AS component_id, c.member_id, c.kind, c.name, coalesce(po.amount, c.amount) AS amount, po.paid_on
           FROM compensation_components c
           LEFT JOIN compensation_component_payouts po
             ON po.organization_id = c.organization_id AND po.component_id = c.id AND po.period = $2::date
          WHERE c.organization_id = $1 AND ${activeIn('$2::date')} AND ($3::uuid IS NULL OR c.member_id = $3)
          ORDER BY c.kind, c.name`,
        [ctx.orgId, period, own ? ctx.memberId : null],
      );
      const sessions = await db.many<{ memberId: string; sessions: number; unpaid: number; paid: number }>(
        `SELECT c.member_id, count(*)::int AS sessions,
                coalesce(sum(c.amount) FILTER (WHERE c.status = 'dihitung'), 0)::bigint AS unpaid,
                coalesce(sum(c.amount) FILTER (WHERE c.status = 'dibayar'), 0)::bigint AS paid
           FROM therapist_compensations c
          WHERE c.organization_id = $1 AND c.status <> 'dibatalkan'
            AND c.session_date >= $2::date AND c.session_date < ($2::date + interval '1 month')
            AND ($3::uuid IS NULL OR c.member_id = $3)
          GROUP BY c.member_id`,
        [ctx.orgId, period, own ? ctx.memberId : null],
      );
      const perSession = await db.many<{ memberId: string }>(
        `SELECT DISTINCT r.member_id FROM compensation_rules r
          WHERE r.organization_id = $1 AND r.effective_from < ($2::date + interval '1 month')
            AND (r.effective_to IS NULL OR r.effective_to >= $2::date) AND ($3::uuid IS NULL OR r.member_id = $3)`,
        [ctx.orgId, period, own ? ctx.memberId : null],
      );
      const ids = [...new Set([...fixed, ...sessions, ...perSession].map((r) => r.memberId))];
      const names = await db.many<{ id: string; fullName: string }>(
        `SELECT m.id, u.full_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 AND m.id = ANY($2::uuid[])`,
        [ctx.orgId, ids],
      );
      const therapists = ids
        .map((id) => {
          const items = fixed.filter((f) => f.memberId === id);
          const s = sessions.find((x) => x.memberId === id) ?? { sessions: 0, unpaid: 0, paid: 0 };
          const fixedTotal = items.reduce((n, f) => n + Number(f.amount), 0);
          const fixedPaid = items.filter((f) => f.paidOn).reduce((n, f) => n + Number(f.amount), 0);
          return {
            memberId: id,
            therapistName: names.find((n) => n.id === id)?.fullName ?? '',
            hasBaseSalary: items.some((f) => f.kind === 'gaji_pokok'),
            hasAllowance: items.some((f) => f.kind === 'tunjangan'),
            hasPerSession: perSession.some((r) => r.memberId === id) || s.sessions > 0,
            fixed: items,
            fixedTotal,
            sessions: s.sessions,
            sessionTotal: Number(s.unpaid) + Number(s.paid),
            total: fixedTotal + Number(s.unpaid) + Number(s.paid),
            unpaid: fixedTotal - fixedPaid + Number(s.unpaid),
            paid: fixedPaid + Number(s.paid),
          };
        })
        .sort((a, b) => a.therapistName.localeCompare(b.therapistName));
      return { month, therapists };
    });
  });

  // Menandai gaji pokok/tunjangan bulan tertentu sebagai dibayar (nominal dibekukan saat itu).
  app.post('/compensation/components/mark-paid', async (req) => {
    const ctx = needTenant(req, 'compensation.manage');
    const body = parse(z.object({ month: zMonth, componentIds: z.array(z.uuid()).min(1).max(500), paidOn: zDate }), req.body);
    const period = monthStart(body.month);
    return tenantTx(app, ctx, async (db) => {
      const n = await db.exec(
        `INSERT INTO compensation_component_payouts (organization_id, member_id, component_id, period, kind, name, amount, paid_on, recorded_by)
         SELECT c.organization_id, c.member_id, c.id, $2::date, c.kind, c.name, c.amount, $4, $5
           FROM compensation_components c
          WHERE c.organization_id = $1 AND c.id = ANY($3::uuid[]) AND ${activeIn('$2::date')}
         ON CONFLICT (organization_id, component_id, period) DO NOTHING`,
        [ctx.orgId, period, body.componentIds, body.paidOn, ctx.userId],
      );
      await audit(db, req, ctx, { action: 'kompensasi.komponen_dibayar', entityType: 'compensation', meta: { bulan: body.month, jumlah: n, tanggal: body.paidOn } });
      return { updated: n };
    });
  });
}
