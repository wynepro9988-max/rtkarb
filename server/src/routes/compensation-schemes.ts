import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { can, needTenant, tenantTx } from '../authz/context.ts';
import type { Db } from '../db.ts';
import { badRequest, conflict } from '../errors.ts';
import { idParam, parse, zOptText, zPositiveMoney, zText } from '../http.ts';

// Skema honor satu terapis diatur sekaligus: gaji pokok, tunjangan, honor per sesi umum, dan tarif
// khusus per layanan. Penyimpanan mengganti skema mulai tanggal 1 bulan berlaku; bulan sebelumnya
// tidak berubah, dan honor sesi yang sudah dihitung tidak dihitung ulang.

const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Format bulan harus YYYY-MM');

const rate = z
  .object({ scheme: z.enum(['tetap_per_sesi', 'persen_tarif']), amount: zPositiveMoney.nullish(), percent: z.number().gt(0).max(100).nullish() })
  .refine((r) => (r.scheme === 'tetap_per_sesi' ? r.amount != null : r.percent != null), 'Isi nominal atau persentase sesuai cara hitung');

const schemeBody = z
  .object({
    effectiveMonth: zMonth,
    baseSalary: zPositiveMoney.nullish(),
    // basis 'harian': tarif x hari hadir (tanggal dengan minimal satu sesi selesai) pada bulan itu.
    allowances: z
      .array(z.object({ name: zText(2, 80), amount: zPositiveMoney, basis: z.enum(['bulanan', 'harian']).default('bulanan') }))
      .max(20)
      .default([]),
    perSession: rate.nullish(),
    serviceRates: z.array(rate.and(z.object({ serviceId: z.uuid() }))).max(30).default([]),
    notes: zOptText(500),
  })
  .refine((b) => new Set(b.allowances.map((a) => a.name.toLowerCase())).size === b.allowances.length, 'Nama tunjangan tidak boleh sama')
  .refine((b) => new Set(b.serviceRates.map((r) => r.serviceId)).size === b.serviceRates.length, 'Satu layanan hanya boleh punya satu tarif khusus');

type Rate = { scheme: 'tetap_per_sesi' | 'persen_tarif'; amount?: number | null; percent?: number | null };

const sameRate = (a: Rate, b: Rate) =>
  a.scheme === b.scheme && (a.scheme === 'tetap_per_sesi' ? Number(a.amount) === Number(b.amount) : Number(a.percent) === Number(b.percent));

interface ComponentRow {
  id: string;
  kind: string;
  name: string;
  amount: number;
  basis: string;
  startMonth: string;
  endMonth: string | null;
  lastPaid: string | null;
}
interface RuleRow {
  id: string;
  serviceId: string | null;
  scheme: Rate['scheme'];
  amount: number | null;
  percent: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  used: boolean;
}

// Skema yang berlaku pada tanggal 1 bulan `period` untuk sejumlah terapis.
async function loadSchemes(db: Db, orgId: string, period: string, memberIds: string[] | null) {
  const therapists = await db.many<{ id: string; fullName: string; specialization: string | null; status: string }>(
    `SELECT m.id, u.full_name, m.specialization, m.status
       FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.is_therapist AND m.role <> 'wali' AND ($2::uuid[] IS NULL OR m.id = ANY($2::uuid[]))
        AND (m.status = 'active' OR EXISTS (SELECT 1 FROM compensation_components c WHERE c.organization_id = m.organization_id AND c.member_id = m.id
                                              AND (c.end_month IS NULL OR c.end_month >= $3::date)))
      ORDER BY m.status, u.full_name`,
    [orgId, memberIds, period],
  );
  const ids = therapists.map((t) => t.id);
  const components = await db.many<{ memberId: string; kind: string; name: string; amount: number; basis: string }>(
    `SELECT c.member_id, c.kind, c.name, c.amount, c.basis FROM compensation_components c
      WHERE c.organization_id = $1 AND c.member_id = ANY($2::uuid[])
        AND c.start_month <= $3::date AND (c.end_month IS NULL OR c.end_month >= $3::date)
      ORDER BY c.kind, c.name`,
    [orgId, ids, period],
  );
  const rules = await db.many<{ memberId: string; serviceId: string | null; serviceName: string | null } & Rate>(
    `SELECT r.member_id, r.service_id, s.name AS service_name, r.scheme, r.amount, r.percent
       FROM compensation_rules r LEFT JOIN therapy_services s ON s.organization_id = r.organization_id AND s.id = r.service_id
      WHERE r.organization_id = $1 AND r.member_id = ANY($2::uuid[])
        AND r.effective_from <= $3::date AND (r.effective_to IS NULL OR r.effective_to >= $3::date)
      ORDER BY s.name NULLS FIRST`,
    [orgId, ids, period],
  );
  // Perubahan yang sudah dijadwalkan untuk bulan setelahnya.
  const upcoming = await db.many<{ memberId: string; month: string }>(
    `SELECT member_id, to_char(min(m), 'YYYY-MM') AS month FROM (
       SELECT member_id, start_month AS m FROM compensation_components
        WHERE organization_id = $1 AND member_id = ANY($2::uuid[]) AND start_month > $3::date
       UNION ALL
       SELECT member_id, (end_month + interval '1 month')::date FROM compensation_components
        WHERE organization_id = $1 AND member_id = ANY($2::uuid[]) AND end_month >= $3::date
       UNION ALL
       SELECT member_id, date_trunc('month', effective_from)::date FROM compensation_rules
        WHERE organization_id = $1 AND member_id = ANY($2::uuid[]) AND effective_from > $3::date
     ) x GROUP BY member_id`,
    [orgId, ids, period],
  );
  return therapists.map((t) => {
    const mine = components.filter((c) => c.memberId === t.id);
    const myRules = rules.filter((r) => r.memberId === t.id);
    const general = myRules.find((r) => !r.serviceId);
    return {
      memberId: t.id,
      fullName: t.fullName,
      specialization: t.specialization,
      active: t.status === 'active',
      baseSalary: mine.find((c) => c.kind === 'gaji_pokok')?.amount ?? null,
      allowances: mine.filter((c) => c.kind === 'tunjangan').map((c) => ({ name: c.name, amount: c.amount, basis: c.basis })),
      perSession: general ? { scheme: general.scheme, amount: general.amount, percent: general.percent } : null,
      serviceRates: myRules
        .filter((r) => r.serviceId)
        .map((r) => ({ serviceId: r.serviceId, serviceName: r.serviceName, scheme: r.scheme, amount: r.amount, percent: r.percent })),
      upcomingMonth: upcoming.find((u) => u.memberId === t.id)?.month ?? null,
    };
  });
}

export async function compensationSchemeRoutes(app: FastifyInstance) {
  app.get('/compensation/schemes', async (req) => {
    const ctx = needTenant(req, 'compensation.read', 'compensation.read.own');
    const { month } = parse(z.object({ month: zMonth }), req.query);
    const own = !can(ctx, 'compensation.read');
    return tenantTx(app, ctx, (db) => loadSchemes(db, ctx.orgId!, `${month}-01`, own ? [ctx.memberId!] : null));
  });

  app.put('/compensation/schemes/:memberId', async (req) => {
    const ctx = needTenant(req, 'compensation.manage');
    const memberId = idParam(req.params, 'memberId');
    const body = parse(schemeBody, req.body);
    const period = `${body.effectiveMonth}-01`;
    return tenantTx(app, ctx, async (db) => {
      const member = await db.maybe(
        `SELECT 1 FROM memberships WHERE organization_id = $1 AND id = $2 AND is_therapist AND role <> 'wali' FOR UPDATE`,
        [ctx.orgId, memberId],
      );
      if (!member) throw badRequest('Terapis tidak valid');
      if (body.serviceRates.length) {
        const n = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM therapy_services WHERE organization_id = $1 AND id = ANY($2::uuid[])`, [
          ctx.orgId,
          body.serviceRates.map((r) => r.serviceId),
        ]);
        if (n.n !== body.serviceRates.length) throw badRequest('Layanan tidak valid');
      }
      const changes = { diakhiri: 0, dihapus: 0, dibuat: 0 };

      // ---- Gaji pokok & tunjangan ----
      const wanted = [
        ...(body.baseSalary ? [{ kind: 'gaji_pokok', name: 'Gaji pokok', amount: body.baseSalary, basis: 'bulanan', kept: false }] : []),
        ...body.allowances.map((a) => ({ kind: 'tunjangan', name: a.name, amount: a.amount, basis: a.basis, kept: false })),
      ];
      const existing = await db.many<ComponentRow>(
        `SELECT c.id, c.kind, c.name, c.amount, c.basis, to_char(c.start_month, 'YYYY-MM') AS start_month, to_char(c.end_month, 'YYYY-MM') AS end_month,
                (SELECT to_char(max(po.period), 'YYYY-MM') FROM compensation_component_payouts po
                  WHERE po.organization_id = c.organization_id AND po.component_id = c.id) AS last_paid
           FROM compensation_components c
          WHERE c.organization_id = $1 AND c.member_id = $2 AND (c.end_month IS NULL OR c.end_month >= $3::date)
          FOR UPDATE`,
        [ctx.orgId, memberId, period],
      );
      for (const c of existing) {
        const match = wanted.find(
          (w) =>
            !w.kept && w.kind === c.kind && w.name.toLowerCase() === c.name.toLowerCase() && Number(w.amount) === Number(c.amount) && w.basis === c.basis,
        );
        if (match && c.startMonth <= body.effectiveMonth && c.endMonth === null) {
          match.kept = true;
          continue;
        }
        if (c.lastPaid && c.lastPaid >= body.effectiveMonth) {
          throw conflict(`${c.name} sudah dibayar untuk ${c.lastPaid}. Pilih bulan berlaku setelah bulan yang sudah dibayar.`);
        }
        if (c.startMonth < body.effectiveMonth) {
          await db.exec(
            `UPDATE compensation_components SET end_month = ($3::date - interval '1 month')::date WHERE organization_id = $1 AND id = $2`,
            [ctx.orgId, c.id, period],
          );
          changes.diakhiri++;
        } else {
          await db.exec(`DELETE FROM compensation_components WHERE organization_id = $1 AND id = $2`, [ctx.orgId, c.id]);
          changes.dihapus++;
        }
      }
      for (const w of wanted.filter((x) => !x.kept)) {
        await db.exec(
          `INSERT INTO compensation_components (organization_id, member_id, kind, name, amount, start_month, notes, created_by, basis)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [ctx.orgId, memberId, w.kind, w.name, w.amount, period, body.notes, ctx.userId, w.basis],
        );
        changes.dibuat++;
      }

      // ---- Honor per sesi: aturan umum (serviceId null) dan tarif khusus per layanan ----
      const wantedRules = [
        ...(body.perSession ? [{ serviceId: null as string | null, ...body.perSession, kept: false }] : []),
        ...body.serviceRates.map((r) => ({ ...r, kept: false })),
      ];
      const rules = await db.many<RuleRow>(
        `SELECT r.id, r.service_id, r.scheme, r.amount, r.percent, r.effective_from::text, r.effective_to::text,
                EXISTS (SELECT 1 FROM therapist_compensations tc WHERE tc.organization_id = r.organization_id AND tc.rule_id = r.id) AS used
           FROM compensation_rules r
          WHERE r.organization_id = $1 AND r.member_id = $2 AND (r.effective_to IS NULL OR r.effective_to >= $3::date)
          FOR UPDATE`,
        [ctx.orgId, memberId, period],
      );
      for (const r of rules) {
        const match = wantedRules.find((w) => !w.kept && w.serviceId === r.serviceId && sameRate(w, r));
        if (match && r.effectiveFrom <= period && r.effectiveTo === null) {
          match.kept = true;
          continue;
        }
        if (r.effectiveFrom < period) {
          await db.exec(`UPDATE compensation_rules SET effective_to = $3::date - 1 WHERE organization_id = $1 AND id = $2`, [ctx.orgId, r.id, period]);
          changes.diakhiri++;
        } else if (r.used) {
          throw conflict('Tarif per sesi yang dimulai pada bulan itu sudah dipakai menghitung honor sesi. Pilih bulan berlaku berikutnya.');
        } else {
          await db.exec(`DELETE FROM compensation_rules WHERE organization_id = $1 AND id = $2`, [ctx.orgId, r.id]);
          changes.dihapus++;
        }
      }
      for (const w of wantedRules.filter((x) => !x.kept)) {
        await db.exec(
          `INSERT INTO compensation_rules (organization_id, member_id, service_id, scheme, amount, percent, effective_from, notes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            ctx.orgId,
            memberId,
            w.serviceId,
            w.scheme,
            w.scheme === 'tetap_per_sesi' ? w.amount : null,
            w.scheme === 'persen_tarif' ? w.percent : null,
            period,
            body.notes,
            ctx.userId,
          ],
        );
        changes.dibuat++;
      }

      await audit(db, req, ctx, {
        action: 'kompensasi.skema_diatur',
        entityType: 'membership',
        entityId: memberId,
        meta: { mulai: body.effectiveMonth, gaji_pokok: body.baseSalary ?? null, tunjangan: body.allowances.length, per_sesi: Boolean(body.perSession), ...changes },
      });
      const [scheme] = await loadSchemes(db, ctx.orgId!, period, [memberId]);
      return { ...scheme, changes };
    });
  });
}
