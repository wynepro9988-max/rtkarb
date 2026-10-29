import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { needTenant, tenantTx } from '../authz/context.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { idParam, parse, zDate, zMethod, zOptText, zPositiveMoney, zRange, zText } from '../http.ts';
import { nextCounter } from '../lib/counters.ts';
import { METHOD_LABEL, orgPdf, printedAt, rp, tgl } from '../lib/pdf-format.ts';
import { pdfReply } from '../lib/pdf.ts';

// Refund (pengembalian dana): selalu terkait satu pembayaran, hanya oleh owner, wajib beralasan,
// dan total refund tidak pernah melebihi nominal pembayaran.
export async function refundRoutes(app: FastifyInstance) {
  app.get('/refunds', async (req) => {
    const ctx = needTenant(req, 'payment.read');
    const q = parse(zRange, req.query);
    return tenantTx(app, ctx, (db) =>
      db.many(
        `SELECT r.id, r.refund_no, r.refunded_on, r.amount, r.method, r.reference, r.reason, r.status, r.void_reason, r.verified_at,
                r.payment_id, pay.receipt_no, p.full_name AS patient_name, p.patient_code, u.full_name AS recorded_by_name
           FROM refunds r
           JOIN payments pay ON pay.organization_id = r.organization_id AND pay.id = r.payment_id
           JOIN patients p ON p.organization_id = r.organization_id AND p.id = r.patient_id
           LEFT JOIN users u ON u.id = r.recorded_by
          WHERE r.organization_id = $1 AND r.refunded_on BETWEEN $2 AND $3
          ORDER BY r.refunded_on DESC, r.created_at DESC`,
        [ctx.orgId, q.from, q.to],
      ),
    );
  });

  app.post('/payments/:id/refunds', async (req, reply) => {
    const ctx = needTenant(req, 'refund.record');
    const paymentId = idParam(req.params);
    const body = parse(
      z.object({ amount: zPositiveMoney, method: zMethod, refundedOn: zDate, reference: zOptText(120), reason: zText(5, 500) }),
      req.body,
    );
    const row = await tenantTx(app, ctx, async (db) => {
      // Baris pembayaran dikunci agar refund bersamaan tidak melebihi nominal.
      const pay = await db.maybe<{ patientId: string; amount: number; status: string; paidOn: string }>(
        `SELECT patient_id, amount, status, paid_on FROM payments WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [ctx.orgId, paymentId],
      );
      if (!pay) throw notFound('Pembayaran');
      if (pay.status !== 'tercatat') throw conflict('Pembayaran yang dibatalkan tidak dapat direfund');
      if (body.refundedOn < pay.paidOn) throw badRequest('Tanggal refund tidak boleh sebelum tanggal pembayaran');
      const { refunded } = await db.one<{ refunded: number }>(
        `SELECT coalesce(sum(amount), 0) AS refunded FROM refunds WHERE organization_id = $1 AND payment_id = $2 AND status = 'tercatat'`,
        [ctx.orgId, paymentId],
      );
      if (refunded + body.amount > pay.amount) throw conflict(`Refund melebihi sisa pembayaran yang dapat dikembalikan (${pay.amount - refunded})`);
      const year = body.refundedOn.slice(0, 4);
      const seq = await nextCounter(db, ctx.orgId!, `refund:${year}`);
      const refundNo = `RF/${year}/${String(seq).padStart(5, '0')}`;
      const r = await db.one<{ id: string }>(
        `INSERT INTO refunds (organization_id, refund_no, payment_id, patient_id, refunded_on, amount, method, reference, reason, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [ctx.orgId, refundNo, paymentId, pay.patientId, body.refundedOn, body.amount, body.method, body.reference, body.reason, ctx.userId],
      );
      await audit(db, req, ctx, { action: 'refund.dicatat', entityType: 'refund', entityId: r.id, meta: { nomor: refundNo, nominal: body.amount, pembayaran_id: paymentId } });
      return { id: r.id, refundNo };
    });
    return reply.status(201).send(row);
  });

  app.post('/refunds/:id/void', async (req) => {
    const ctx = needTenant(req, 'refund.void');
    const id = idParam(req.params);
    const { reason } = parse(z.object({ reason: zText(5, 500) }), req.body);
    await tenantTx(app, ctx, async (db) => {
      const n = await db.exec(
        `UPDATE refunds SET status = 'dibatalkan', void_reason = $3, voided_at = now(), voided_by = $4
          WHERE organization_id = $1 AND id = $2 AND status = 'tercatat'`,
        [ctx.orgId, id, reason, ctx.userId],
      );
      if (n === 0) throw notFound('Refund');
      await audit(db, req, ctx, { action: 'refund.dibatalkan', entityType: 'refund', entityId: id });
    });
    return { ok: true };
  });

  app.get('/refunds/:id/pdf', async (req, reply) => {
    const ctx = needTenant(req, 'payment.read');
    const id = idParam(req.params);
    const out = await tenantTx(app, ctx, async (db) => {
      const r = await db.maybe<Record<string, any>>(
        `SELECT r.refund_no, r.refunded_on, r.amount, r.method, r.reference, r.reason, r.status, r.void_reason,
                pay.receipt_no, pay.amount AS payment_amount, p.full_name AS patient_name, p.patient_code, u.full_name AS recorded_by_name
           FROM refunds r
           JOIN payments pay ON pay.organization_id = r.organization_id AND pay.id = r.payment_id
           JOIN patients p ON p.organization_id = r.organization_id AND p.id = r.patient_id
           LEFT JOIN users u ON u.id = r.recorded_by
          WHERE r.organization_id = $1 AND r.id = $2`,
        [ctx.orgId, id],
      );
      if (!r) throw notFound('Refund');
      const doc = await orgPdf(db, ctx, `BUKTI PENGEMBALIAN DANA ${r.refundNo}`, `Tanggal ${tgl(r.refundedOn)}`);
      if (r.status === 'dibatalkan') doc.stamp('DIBATALKAN');
      doc.keyValues([
        ['Dikembalikan kepada', `Wali dari ${r.patientName} (${r.patientCode})`],
        ['Atas pembayaran', `${r.receiptNo} (${rp(r.paymentAmount)})`],
        ['Metode', `${METHOD_LABEL[r.method]}${r.reference ? ` - ref. ${r.reference}` : ''}`],
        ['Alasan', r.reason],
      ]);
      doc.amountBox('Jumlah dikembalikan', rp(r.amount));
      doc.signature('Disetujui & dicatat oleh', r.recordedByName ?? '');
      return { file: doc.toBuffer({ printedAt: printedAt(ctx) }), no: r.refundNo as string };
    });
    return pdfReply(reply, out.file, `refund-${out.no}.pdf`);
  });
}
