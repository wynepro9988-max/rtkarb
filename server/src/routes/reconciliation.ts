import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { needTenant, tenantTx } from '../authz/context.ts';
import type { Db } from '../db.ts';
import { conflict, notFound } from '../errors.ts';
import { parse, zMethod, zOptText, zRange } from '../http.ts';

// Rekonsiliasi: membandingkan arus kas tercatat di sistem (pembayaran − refund − pengeluaran)
// per metode & periode dengan saldo/mutasi nyata (rekening koran, hitungan kas), serta
// menandai transaksi yang sudah dicocokkan.
const periodQuery = zRange.and(z.object({ method: zMethod }));

async function movements(db: Db, orgId: string, from: string, to: string, method: string) {
  const rows = await db.many<{ kind: string; id: string; date: string; ref: string; description: string; amount: number; verifiedAt: Date | null }>(
    `SELECT 'pembayaran' AS kind, pay.id, pay.paid_on AS date, pay.receipt_no AS ref,
            'Pembayaran ' || p.patient_code AS description, pay.amount, pay.verified_at
       FROM payments pay JOIN patients p ON p.organization_id = pay.organization_id AND p.id = pay.patient_id
      WHERE pay.organization_id = $1 AND pay.status = 'tercatat' AND pay.method = $4 AND pay.paid_on BETWEEN $2 AND $3
     UNION ALL
     SELECT 'refund', r.id, r.refunded_on, r.refund_no, 'Refund ' || p.patient_code, -r.amount, r.verified_at
       FROM refunds r JOIN patients p ON p.organization_id = r.organization_id AND p.id = r.patient_id
      WHERE r.organization_id = $1 AND r.status = 'tercatat' AND r.method = $4 AND r.refunded_on BETWEEN $2 AND $3
     UNION ALL
     SELECT 'pengeluaran', e.id, e.spent_on, e.category, e.description, -e.amount, e.verified_at
       FROM expenses e
      WHERE e.organization_id = $1 AND e.status = 'tercatat' AND e.method = $4 AND e.spent_on BETWEEN $2 AND $3
     ORDER BY 3, 4`,
    [orgId, from, to, method],
  );
  const sumIn = rows.filter((r) => r.amount > 0).reduce((n, r) => n + r.amount, 0);
  const sumOut = rows.filter((r) => r.amount < 0).reduce((n, r) => n - r.amount, 0);
  return { rows, systemIn: sumIn, systemOut: sumOut, systemNet: sumIn - sumOut, unverified: rows.filter((r) => !r.verifiedAt).length };
}

const TABLE: Record<string, string> = { pembayaran: 'payments', refund: 'refunds', pengeluaran: 'expenses' };

export async function reconciliationRoutes(app: FastifyInstance) {
  app.get('/finance/reconciliation', async (req) => {
    const ctx = needTenant(req, 'finance.reconcile');
    const q = parse(periodQuery, req.query);
    return tenantTx(app, ctx, (db) => movements(db, ctx.orgId!, q.from, q.to, q.method));
  });

  app.post('/finance/verify', async (req) => {
    const ctx = needTenant(req, 'finance.reconcile');
    const body = parse(z.object({ kind: z.enum(['pembayaran', 'refund', 'pengeluaran']), id: z.uuid(), verified: z.boolean() }), req.body);
    await tenantTx(app, ctx, async (db) => {
      const n = await db.exec(
        `UPDATE ${TABLE[body.kind]} SET verified_at = CASE WHEN $3::boolean THEN now() END, verified_by = CASE WHEN $3::boolean THEN $4::uuid END
          WHERE organization_id = $1 AND id = $2 AND status = 'tercatat'`,
        [ctx.orgId, body.id, body.verified, ctx.userId],
      );
      if (n === 0) throw notFound('Transaksi');
      await audit(db, req, ctx, { action: body.verified ? 'keuangan.diverifikasi' : 'keuangan.verifikasi_dibatalkan', entityType: TABLE[body.kind], entityId: body.id });
    });
    return { ok: true };
  });

  app.get('/reconciliations', async (req) => {
    const ctx = needTenant(req, 'finance.reconcile');
    return tenantTx(app, ctx, (db) =>
      db.many(
        `SELECT r.id, r.period_from, r.period_to, r.method, r.system_in, r.system_out, r.system_net, r.actual_net, r.difference,
                r.unverified_count, r.notes, r.status, r.created_at, r.finalized_at, u.full_name AS created_by_name, f.full_name AS finalized_by_name
           FROM reconciliations r
           LEFT JOIN users u ON u.id = r.created_by
           LEFT JOIN users f ON f.id = r.finalized_by
          WHERE r.organization_id = $1 ORDER BY r.period_from DESC, r.created_at DESC LIMIT 100`,
        [ctx.orgId],
      ),
    );
  });

  // Menyimpan hasil pencocokan (snapshot angka sistem saat itu + saldo nyata).
  app.post('/reconciliations', async (req, reply) => {
    const ctx = needTenant(req, 'finance.reconcile');
    const body = parse(
      periodQuery.and(z.object({ actualNet: z.number().int().min(-1_000_000_000_000).max(1_000_000_000_000), notes: zOptText(1000) })),
      req.body,
    );
    const row = await tenantTx(app, ctx, async (db) => {
      const m = await movements(db, ctx.orgId!, body.from, body.to, body.method);
      const r = await db.one<{ id: string; difference: number }>(
        `INSERT INTO reconciliations (organization_id, period_from, period_to, method, system_in, system_out, system_net, actual_net, difference, unverified_count, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, difference`,
        [ctx.orgId, body.from, body.to, body.method, m.systemIn, m.systemOut, m.systemNet, body.actualNet, body.actualNet - m.systemNet, m.unverified, body.notes, ctx.userId],
      );
      await audit(db, req, ctx, { action: 'keuangan.rekonsiliasi_dibuat', entityType: 'reconciliation', entityId: r.id, meta: { metode: body.method, selisih: r.difference } });
      return r;
    });
    return reply.status(201).send(row);
  });

  app.post('/reconciliations/:id/finalize', async (req) => {
    const ctx = needTenant(req, 'finance.reconcile.finalize');
    const id = z.uuid().safeParse((req.params as { id: string }).id);
    if (!id.success) throw notFound('Rekonsiliasi');
    await tenantTx(app, ctx, async (db) => {
      const n = await db.exec(
        `UPDATE reconciliations SET status = 'final', finalized_by = $3, finalized_at = now()
          WHERE organization_id = $1 AND id = $2 AND status = 'draf'`,
        [ctx.orgId, id.data, ctx.userId],
      );
      if (n === 0) throw conflict('Rekonsiliasi tidak ditemukan atau sudah final');
      await audit(db, req, ctx, { action: 'keuangan.rekonsiliasi_final', entityType: 'reconciliation', entityId: id.data });
    });
    return { ok: true };
  });
}
