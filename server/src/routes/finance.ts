import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { needTenant, tenantTx } from '../authz/context.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { idParam, parse, zDate, zMethod, zOptText, zPositiveMoney, zRange, zText } from '../http.ts';
import { nextCounter } from '../lib/counters.ts';
import { invoicedSql, netPaidSql } from '../lib/money-sql.ts';
import { METHOD_LABEL, orgPdf, printedAt, rp, tgl } from '../lib/pdf-format.ts';
import { pdfReply } from '../lib/pdf.ts';
import type { Db } from '../db.ts';
import { requirePatient } from './patients.ts';

const paymentBody = z.object({
  patientId: z.uuid(),
  amount: zPositiveMoney,
  method: zMethod,
  paidOn: zDate,
  reference: zOptText(120),
  notes: zOptText(500),
  patientPackageId: z.uuid().nullish(),
  appointmentId: z.uuid().nullish(),
  invoiceId: z.uuid().nullish(),
});

const expenseBody = z.object({
  spentOn: zDate,
  category: zText(2, 60),
  description: zText(2, 500),
  amount: zPositiveMoney,
  method: zMethod,
  reference: zOptText(120),
});

// Paket/sesi yang sudah ditagihkan lewat invoice dibayar melalui invoice tersebut.
async function assertNotInvoiced(db: Db, orgId: string, column: 'patient_package_id' | 'appointment_id', id: string) {
  const inv = await db.maybe<{ invoiceNo: string }>(
    `SELECT i.invoice_no FROM invoice_items ii JOIN invoices i ON i.organization_id = ii.organization_id AND i.id = ii.invoice_id
      WHERE ii.organization_id = $1 AND ii.${column} = $2 AND ii.active LIMIT 1`,
    [orgId, id],
  );
  if (inv) throw badRequest(`Sudah ditagihkan dalam invoice ${inv.invoiceNo}. Catat pembayaran pada invoice tersebut.`);
}

export async function financeRoutes(app: FastifyInstance) {
  // ---- Pembayaran ----
  app.get('/payments', async (req) => {
    const ctx = needTenant(req, 'payment.read');
    const q = parse(
      zRange.and(z.object({ method: zMethod.optional(), status: z.enum(['tercatat', 'dibatalkan']).optional() })),
      req.query,
    );
    return tenantTx(app, ctx, (db) =>
      db.many(
        `SELECT pay.id, pay.receipt_no, pay.paid_on, pay.amount, pay.method, pay.reference, pay.status, pay.void_reason,
                pay.patient_id, p.full_name AS patient_name, p.patient_code,
                pp.name AS package_name, pay.appointment_id, u.full_name AS recorded_by_name
           FROM payments pay
           JOIN patients p ON p.organization_id = pay.organization_id AND p.id = pay.patient_id
           LEFT JOIN patient_packages pp ON pp.organization_id = pay.organization_id AND pp.id = pay.patient_package_id
           LEFT JOIN users u ON u.id = pay.recorded_by
          WHERE pay.organization_id = $1 AND pay.paid_on BETWEEN $2 AND $3
            AND ($4::text IS NULL OR pay.method = $4)
            AND ($5::text IS NULL OR pay.status = $5)
          ORDER BY pay.paid_on DESC, pay.created_at DESC`,
        [ctx.orgId, q.from, q.to, q.method ?? null, q.status ?? null],
      ),
    );
  });

  app.post('/payments', async (req, reply) => {
    const ctx = needTenant(req, 'payment.record');
    const body = parse(paymentBody, req.body);
    if ([body.patientPackageId, body.appointmentId, body.invoiceId].filter(Boolean).length > 1) {
      throw badRequest('Pilih salah satu: invoice, paket, atau sesi');
    }
    const created = await tenantTx(app, ctx, async (db) => {
      await requirePatient(db, ctx.orgId!, body.patientId);
      if (body.patientPackageId) {
        const pkg = await db.maybe(`SELECT 1 FROM patient_packages WHERE organization_id = $1 AND id = $2 AND patient_id = $3`, [
          ctx.orgId,
          body.patientPackageId,
          body.patientId,
        ]);
        if (!pkg) throw badRequest('Paket tidak ditemukan untuk pasien ini');
        await assertNotInvoiced(db, ctx.orgId!, 'patient_package_id', body.patientPackageId);
      }
      if (body.appointmentId) {
        const a = await db.maybe<{ billing: string }>(
          `SELECT billing FROM appointments WHERE organization_id = $1 AND id = $2 AND patient_id = $3`,
          [ctx.orgId, body.appointmentId, body.patientId],
        );
        if (!a) throw badRequest('Sesi tidak ditemukan untuk pasien ini');
        if (a.billing !== 'per_sesi') throw badRequest('Pembayaran per sesi hanya untuk sesi dengan tagihan per sesi');
        await assertNotInvoiced(db, ctx.orgId!, 'appointment_id', body.appointmentId);
      }
      if (body.invoiceId) {
        // Kunci invoice agar dua pembayaran bersamaan tidak melebihi sisa tagihan.
        const inv = await db.maybe<{ status: string; total: number; paid: number }>(
          `SELECT i.status, i.total, ${netPaidSql('i', 'invoice_id')} AS paid
             FROM invoices i WHERE i.organization_id = $1 AND i.id = $2 AND i.patient_id = $3 FOR UPDATE`,
          [ctx.orgId, body.invoiceId, body.patientId],
        );
        if (!inv) throw badRequest('Invoice tidak ditemukan untuk pasien ini');
        if (inv.status !== 'terbit') throw badRequest('Invoice ini sudah dibatalkan');
        if (body.amount > inv.total - inv.paid) throw badRequest(`Nominal melebihi sisa tagihan (${inv.total - inv.paid})`);
      }
      const org = await db.one<{ receiptPrefix: string }>(`SELECT receipt_prefix FROM organizations WHERE id = $1`, [ctx.orgId]);
      const year = body.paidOn.slice(0, 4);
      const seq = await nextCounter(db, ctx.orgId!, `receipt:${year}`);
      const receiptNo = `${org.receiptPrefix}/${year}/${String(seq).padStart(5, '0')}`;
      const row = await db.one<{ id: string; receiptNo: string }>(
        `INSERT INTO payments
           (organization_id, receipt_no, patient_id, patient_package_id, appointment_id, invoice_id, paid_on, amount, method, reference, notes, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $12, $6, $7, $8, $9, $10, $11) RETURNING id, receipt_no`,
        [
          ctx.orgId,
          receiptNo,
          body.patientId,
          body.patientPackageId ?? null,
          body.appointmentId ?? null,
          body.paidOn,
          body.amount,
          body.method,
          body.reference,
          body.notes,
          ctx.userId,
          body.invoiceId ?? null,
        ],
      );
      await audit(db, req, ctx, {
        action: 'pembayaran.dicatat',
        entityType: 'payment',
        entityId: row.id,
        meta: { kuitansi: receiptNo, nominal: body.amount, metode: body.method },
      });
      return row;
    });
    return reply.status(201).send(created);
  });

  // Data kuitansi.
  app.get('/payments/:id', async (req) => {
    const ctx = needTenant(req, 'payment.read');
    const id = idParam(req.params);
    return tenantTx(app, ctx, async (db) => {
      const row = await db.maybe(
        `SELECT pay.id, pay.receipt_no, pay.paid_on, pay.amount, pay.method, pay.reference, pay.notes, pay.status, pay.void_reason, pay.voided_at,
                pay.created_at, p.full_name AS patient_name, p.patient_code, pp.name AS package_name,
                to_char(a.starts_at AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') AS session_at, s.name AS service_name,
                u.full_name AS recorded_by_name, pay.invoice_id, inv.invoice_no, pay.verified_at,
                coalesce((SELECT sum(r.amount) FROM refunds r WHERE r.organization_id = pay.organization_id AND r.payment_id = pay.id AND r.status = 'tercatat'), 0) AS refunded,
                o.name AS organization_name, o.address AS organization_address, o.phone AS organization_phone
           FROM payments pay
           LEFT JOIN invoices inv ON inv.organization_id = pay.organization_id AND inv.id = pay.invoice_id
           JOIN organizations o ON o.id = pay.organization_id
           JOIN patients p ON p.organization_id = pay.organization_id AND p.id = pay.patient_id
           LEFT JOIN patient_packages pp ON pp.organization_id = pay.organization_id AND pp.id = pay.patient_package_id
           LEFT JOIN appointments a ON a.organization_id = pay.organization_id AND a.id = pay.appointment_id
           LEFT JOIN therapy_services s ON s.organization_id = a.organization_id AND s.id = a.service_id
           LEFT JOIN users u ON u.id = pay.recorded_by
          WHERE pay.organization_id = $1 AND pay.id = $2`,
        [ctx.orgId, id, ctx.timezone],
      );
      if (!row) throw notFound('Pembayaran');
      const refunds = await db.many(
        `SELECT id, refund_no, refunded_on, amount, method, reason, status FROM refunds
          WHERE organization_id = $1 AND payment_id = $2 ORDER BY refunded_on, created_at`,
        [ctx.orgId, id],
      );
      return { ...row, refunds };
    });
  });

  // Kuitansi PDF (berfungsi juga di aplikasi Android, yang tidak mendukung window.print).
  app.get('/payments/:id/pdf', async (req, reply) => {
    const ctx = needTenant(req, 'payment.read');
    const id = idParam(req.params);
    const out = await tenantTx(app, ctx, async (db) => {
      const r = await db.maybe<Record<string, any>>(
        `SELECT pay.receipt_no, pay.paid_on, pay.amount, pay.method, pay.reference, pay.notes, pay.status, pay.void_reason,
                p.full_name AS patient_name, p.patient_code, pp.name AS package_name, inv.invoice_no,
                to_char(a.starts_at AT TIME ZONE $3, 'DD-MM-YYYY HH24:MI') AS session_at, s.name AS service_name,
                u.full_name AS recorded_by_name,
                coalesce((SELECT sum(rf.amount) FROM refunds rf WHERE rf.organization_id = pay.organization_id AND rf.payment_id = pay.id AND rf.status = 'tercatat'), 0) AS refunded
           FROM payments pay
           JOIN patients p ON p.organization_id = pay.organization_id AND p.id = pay.patient_id
           LEFT JOIN patient_packages pp ON pp.organization_id = pay.organization_id AND pp.id = pay.patient_package_id
           LEFT JOIN invoices inv ON inv.organization_id = pay.organization_id AND inv.id = pay.invoice_id
           LEFT JOIN appointments a ON a.organization_id = pay.organization_id AND a.id = pay.appointment_id
           LEFT JOIN therapy_services s ON s.organization_id = a.organization_id AND s.id = a.service_id
           LEFT JOIN users u ON u.id = pay.recorded_by
          WHERE pay.organization_id = $1 AND pay.id = $2`,
        [ctx.orgId, id, ctx.timezone],
      );
      if (!r) throw notFound('Pembayaran');
      const purpose = r.invoiceNo
        ? `Invoice ${r.invoiceNo}`
        : r.packageName
          ? (/^paket\b/i.test(r.packageName) ? r.packageName : `Paket ${r.packageName}`)
          : r.sessionAt
            ? `Sesi ${r.serviceName ?? 'terapi'} ${r.sessionAt}`
            : (r.notes ?? 'Layanan terapi');
      const doc = await orgPdf(db, ctx, `KUITANSI ${r.receiptNo}`, `Tanggal ${tgl(r.paidOn)}`);
      if (r.status === 'dibatalkan') doc.stamp('DIBATALKAN');
      doc.keyValues([
        ['Diterima dari', `Wali dari ${r.patientName} (${r.patientCode})`],
        ['Untuk pembayaran', purpose],
        ['Metode', `${METHOD_LABEL[r.method]}${r.reference ? ` - ref. ${r.reference}` : ''}`],
      ]);
      doc.amountBox('Jumlah diterima', rp(r.amount));
      if (r.refunded > 0) doc.paragraph(`Telah dikembalikan (refund): ${rp(r.refunded)}. Nilai bersih: ${rp(r.amount - r.refunded)}.`);
      if (r.status === 'dibatalkan') doc.paragraph(`Dibatalkan: ${r.voidReason ?? ''}`, { muted: true });
      doc.signature('Petugas', r.recordedByName ?? '');
      await audit(db, req, ctx, { action: 'pembayaran.pdf_diunduh', entityType: 'payment', entityId: id });
      return { file: doc.toBuffer({ printedAt: printedAt(ctx) }), no: r.receiptNo as string };
    });
    return pdfReply(reply, out.file, `kuitansi-${out.no}.pdf`);
  });

  app.post('/payments/:id/void', async (req) => {
    const ctx = needTenant(req, 'payment.void');
    const id = idParam(req.params);
    const { reason } = parse(z.object({ reason: zText(5, 500) }), req.body);
    await tenantTx(app, ctx, async (db) => {
      const refunded = await db.maybe(`SELECT 1 FROM refunds WHERE organization_id = $1 AND payment_id = $2 AND status = 'tercatat' LIMIT 1`, [ctx.orgId, id]);
      if (refunded) throw conflict('Pembayaran ini memiliki refund. Batalkan refund terlebih dahulu.');
      const n = await db.exec(
        `UPDATE payments SET status = 'dibatalkan', void_reason = $3, voided_at = now(), voided_by = $4
          WHERE organization_id = $1 AND id = $2 AND status = 'tercatat'`,
        [ctx.orgId, id, reason, ctx.userId],
      );
      if (n === 0) {
        const exists = await db.maybe(`SELECT 1 FROM payments WHERE organization_id = $1 AND id = $2`, [ctx.orgId, id]);
        if (!exists) throw notFound('Pembayaran');
        throw conflict('Pembayaran ini sudah dibatalkan');
      }
      await audit(db, req, ctx, { action: 'pembayaran.dibatalkan', entityType: 'payment', entityId: id });
    });
    return { ok: true };
  });

  // Tagihan yang belum lunas: invoice, serta sesi per-sesi selesai & paket yang belum ditagihkan lewat invoice.
  // Semua nilai terbayar adalah nilai BERSIH (setelah refund).
  app.get('/finance/outstanding', async (req) => {
    const ctx = needTenant(req, 'payment.read');
    return tenantTx(app, ctx, async (db) => {
      const sessions = await db.many(
        `SELECT * FROM (
           SELECT a.id AS appointment_id, a.patient_id, p.full_name AS patient_name, p.patient_code,
                  to_char(a.starts_at AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS session_at, s.name AS service_name, a.starts_at,
                  a.price, ${netPaidSql('a', 'appointment_id')} AS paid
             FROM appointments a
             JOIN patients p ON p.organization_id = a.organization_id AND p.id = a.patient_id
             LEFT JOIN therapy_services s ON s.organization_id = a.organization_id AND s.id = a.service_id
            WHERE a.organization_id = $1 AND a.status = 'selesai' AND a.billing = 'per_sesi' AND a.price > 0
              AND NOT ${invoicedSql('a', 'appointment_id')}) x
          WHERE price - paid > 0 ORDER BY starts_at`,
        [ctx.orgId, ctx.timezone],
      );
      const packages = await db.many(
        `SELECT * FROM (
           SELECT pp.id AS patient_package_id, pp.patient_id, p.full_name AS patient_name, p.patient_code, pp.name, pp.purchased_on,
                  pp.price, ${netPaidSql('pp', 'patient_package_id')} AS paid
             FROM patient_packages pp
             JOIN patients p ON p.organization_id = pp.organization_id AND p.id = pp.patient_id
            WHERE pp.organization_id = $1 AND pp.status <> 'dibatalkan' AND pp.price > 0
              AND NOT ${invoicedSql('pp', 'patient_package_id')}) x
          WHERE price - paid > 0 ORDER BY purchased_on`,
        [ctx.orgId],
      );
      const invoices = await db.many(
        `SELECT * FROM (
           SELECT i.id AS invoice_id, i.invoice_no, i.patient_id, p.full_name AS patient_name, p.patient_code, i.issued_on, i.due_on,
                  i.total AS price, ${netPaidSql('i', 'invoice_id')} AS paid
             FROM invoices i JOIN patients p ON p.organization_id = i.organization_id AND p.id = i.patient_id
            WHERE i.organization_id = $1 AND i.status = 'terbit') x
          WHERE price - paid > 0 ORDER BY issued_on`,
        [ctx.orgId],
      );
      const withOutstanding = <T extends { price: number; paid: number }>(rows: T[]) => rows.map((r) => ({ ...r, outstanding: r.price - r.paid }));
      return { sessions: withOutstanding(sessions as any), packages: withOutstanding(packages as any), invoices: withOutstanding(invoices as any) };
    });
  });

  // ---- Pengeluaran ----
  app.get('/expenses', async (req) => {
    const ctx = needTenant(req, 'expense.read');
    const q = parse(zRange, req.query);
    return tenantTx(app, ctx, (db) =>
      db.many(
        `SELECT e.id, e.spent_on, e.category, e.description, e.amount, e.method, e.reference, e.status, e.void_reason,
                u.full_name AS recorded_by_name
           FROM expenses e LEFT JOIN users u ON u.id = e.recorded_by
          WHERE e.organization_id = $1 AND e.spent_on BETWEEN $2 AND $3
          ORDER BY e.spent_on DESC, e.created_at DESC`,
        [ctx.orgId, q.from, q.to],
      ),
    );
  });

  app.post('/expenses', async (req, reply) => {
    const ctx = needTenant(req, 'expense.record');
    const body = parse(expenseBody, req.body);
    const row = await tenantTx(app, ctx, async (db) => {
      const e = await db.one<{ id: string }>(
        `INSERT INTO expenses (organization_id, spent_on, category, description, amount, method, reference, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [ctx.orgId, body.spentOn, body.category, body.description, body.amount, body.method, body.reference, ctx.userId],
      );
      await audit(db, req, ctx, { action: 'pengeluaran.dicatat', entityType: 'expense', entityId: e.id, meta: { nominal: body.amount, kategori: body.category } });
      return e;
    });
    return reply.status(201).send(row);
  });

  app.post('/expenses/:id/void', async (req) => {
    const ctx = needTenant(req, 'expense.void');
    const id = idParam(req.params);
    const { reason } = parse(z.object({ reason: zText(5, 500) }), req.body);
    await tenantTx(app, ctx, async (db) => {
      const n = await db.exec(
        `UPDATE expenses SET status = 'dibatalkan', void_reason = $3, voided_at = now(), voided_by = $4
          WHERE organization_id = $1 AND id = $2 AND status = 'tercatat'`,
        [ctx.orgId, id, reason, ctx.userId],
      );
      if (n === 0) throw notFound('Pengeluaran');
      await audit(db, req, ctx, { action: 'pengeluaran.dibatalkan', entityType: 'expense', entityId: id });
    });
    return { ok: true };
  });
}
