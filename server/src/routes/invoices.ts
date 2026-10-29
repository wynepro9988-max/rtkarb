import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { can, needTenant, tenantTx } from '../authz/context.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { idParam, parse, zDate, zMoney, zOptText, zRange, zText } from '../http.ts';
import { nextCounter } from '../lib/counters.ts';
import { invoicedSql, netPaidSql } from '../lib/money-sql.ts';
import { METHOD_LABEL, orgPdf, printedAt, rp, tgl } from '../lib/pdf-format.ts';
import { pdfReply } from '../lib/pdf.ts';
import { requirePatient } from './patients.ts';

const itemBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('paket'), patientPackageId: z.uuid(), discountAmount: zMoney.default(0) }),
  z.object({ kind: z.literal('sesi'), appointmentId: z.uuid(), discountAmount: zMoney.default(0) }),
  z.object({
    kind: z.literal('lainnya'),
    description: zText(2, 200),
    quantity: z.number().int().min(1).max(1000).default(1),
    unitPrice: zMoney,
    discountAmount: zMoney.default(0),
  }),
]);

const invoiceBody = z.object({
  patientId: z.uuid(),
  issuedOn: zDate.optional(),
  dueOn: zDate.nullish(),
  notes: zOptText(1000),
  discountReason: zOptText(500),
  items: z.array(itemBody).min(1).max(50),
});

const STATUS_SQL = (alias: string) => `
  CASE WHEN ${alias}.status = 'dibatalkan' THEN 'dibatalkan'
       WHEN ${netPaidSql(alias, 'invoice_id')} >= ${alias}.total THEN 'lunas'
       WHEN ${netPaidSql(alias, 'invoice_id')} > 0 THEN 'sebagian'
       ELSE 'belum_dibayar' END`;

export const INVOICE_FIELDS = `i.id, i.invoice_no, i.patient_id, p.full_name AS patient_name, p.patient_code, i.issued_on, i.due_on,
  i.subtotal, i.discount_total, i.total, i.discount_reason, i.notes, i.status, i.void_reason, i.created_at,
  ${netPaidSql('i', 'invoice_id')} AS paid, ${STATUS_SQL('i')} AS payment_status`;

export async function invoiceRoutes(app: FastifyInstance) {
  app.get('/invoices', async (req) => {
    const ctx = needTenant(req, 'invoice.read');
    const q = parse(zRange.and(z.object({ patientId: z.uuid().optional() })), req.query);
    return tenantTx(app, ctx, (db) =>
      db.many(
        `SELECT ${INVOICE_FIELDS}
           FROM invoices i JOIN patients p ON p.organization_id = i.organization_id AND p.id = i.patient_id
          WHERE i.organization_id = $1 AND i.issued_on BETWEEN $2 AND $3 AND ($4::uuid IS NULL OR i.patient_id = $4)
          ORDER BY i.issued_on DESC, i.created_at DESC`,
        [ctx.orgId, q.from, q.to, q.patientId ?? null],
      ),
    );
  });

  // Paket & sesi per-sesi yang belum ditagihkan dan belum dibayar langsung (untuk formulir invoice).
  app.get('/patients/:id/billable', async (req) => {
    const ctx = needTenant(req, 'invoice.create');
    const patientId = idParam(req.params);
    return tenantTx(app, ctx, async (db) => {
      await requirePatient(db, ctx.orgId!, patientId);
      const packages = await db.many(
        `SELECT pp.id, pp.name, pp.price, pp.purchased_on FROM patient_packages pp
          WHERE pp.organization_id = $1 AND pp.patient_id = $2 AND pp.status <> 'dibatalkan' AND pp.price > 0
            AND NOT ${invoicedSql('pp', 'patient_package_id')} AND ${netPaidSql('pp', 'patient_package_id')} = 0
          ORDER BY pp.purchased_on DESC`,
        [ctx.orgId, patientId],
      );
      const sessions = await db.many(
        `SELECT a.id, a.price, a.status, to_char(a.starts_at AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') AS session_at, s.name AS service_name
           FROM appointments a LEFT JOIN therapy_services s ON s.organization_id = a.organization_id AND s.id = a.service_id
          WHERE a.organization_id = $1 AND a.patient_id = $2 AND a.billing = 'per_sesi' AND a.price > 0
            AND a.status IN ('terjadwal', 'selesai')
            AND NOT ${invoicedSql('a', 'appointment_id')} AND ${netPaidSql('a', 'appointment_id')} = 0
          ORDER BY a.starts_at`,
        [ctx.orgId, patientId, ctx.timezone],
      );
      return { packages, sessions };
    });
  });

  app.post('/invoices', async (req, reply) => {
    const ctx = needTenant(req, 'invoice.create');
    const body = parse(invoiceBody, req.body);
    const created = await tenantTx(app, ctx, async (db) => {
      await requirePatient(db, ctx.orgId!, body.patientId);
      const org = await db.one<{ invoicePrefix: string; financeDiscountMaxPercent: number; today: string }>(
        `SELECT invoice_prefix, finance_discount_max_percent, to_char(now() AT TIME ZONE timezone, 'YYYY-MM-DD') AS today
           FROM organizations WHERE id = $1`,
        [ctx.orgId],
      );
      const issuedOn = body.issuedOn ?? org.today;
      if (body.dueOn && body.dueOn < issuedOn) throw badRequest('Jatuh tempo harus setelah tanggal invoice');

      // Harga paket/sesi diambil dari database, bukan dari klien.
      const lines: { description: string; quantity: number; unitPrice: number; discount: number; packageId: string | null; appointmentId: string | null }[] = [];
      for (const item of body.items) {
        if (item.kind === 'paket') {
          const pkg = await db.maybe<{ name: string; price: number; status: string; invoiced: boolean; paid: number }>(
            `SELECT pp.name, pp.price, pp.status, ${invoicedSql('pp', 'patient_package_id')} AS invoiced, ${netPaidSql('pp', 'patient_package_id')} AS paid
               FROM patient_packages pp WHERE pp.organization_id = $1 AND pp.id = $2 AND pp.patient_id = $3`,
            [ctx.orgId, item.patientPackageId, body.patientId],
          );
          if (!pkg) throw badRequest('Paket tidak ditemukan untuk pasien ini');
          if (pkg.status === 'dibatalkan') throw badRequest('Paket yang dibatalkan tidak dapat ditagihkan');
          if (pkg.invoiced) throw conflict('Paket ini sudah ada di invoice lain yang aktif');
          if (pkg.paid > 0) throw conflict('Paket ini sudah memiliki pembayaran langsung');
          lines.push({ description: /^paket\b/i.test(pkg.name) ? pkg.name : `Paket ${pkg.name}`, quantity: 1, unitPrice: pkg.price, discount: item.discountAmount, packageId: item.patientPackageId, appointmentId: null });
        } else if (item.kind === 'sesi') {
          const a = await db.maybe<{ price: number; billing: string; status: string; sessionAt: string; serviceName: string | null; invoiced: boolean; paid: number }>(
            `SELECT a.price, a.billing, a.status, to_char(a.starts_at AT TIME ZONE $4, 'DD-MM-YYYY HH24:MI') AS session_at, s.name AS service_name,
                    ${invoicedSql('a', 'appointment_id')} AS invoiced, ${netPaidSql('a', 'appointment_id')} AS paid
               FROM appointments a LEFT JOIN therapy_services s ON s.organization_id = a.organization_id AND s.id = a.service_id
              WHERE a.organization_id = $1 AND a.id = $2 AND a.patient_id = $3`,
            [ctx.orgId, item.appointmentId, body.patientId, ctx.timezone],
          );
          if (!a) throw badRequest('Sesi tidak ditemukan untuk pasien ini');
          if (a.billing !== 'per_sesi' || a.price <= 0) throw badRequest('Hanya sesi bertagihan per sesi yang dapat ditagihkan');
          if (!['terjadwal', 'selesai'].includes(a.status)) throw badRequest('Sesi yang dibatalkan/dijadwal ulang tidak dapat ditagihkan');
          if (a.invoiced) throw conflict('Sesi ini sudah ada di invoice lain yang aktif');
          if (a.paid > 0) throw conflict('Sesi ini sudah memiliki pembayaran langsung');
          lines.push({ description: `Sesi ${a.serviceName ?? 'terapi'} ${a.sessionAt}`, quantity: 1, unitPrice: a.price, discount: item.discountAmount, packageId: null, appointmentId: item.appointmentId });
        } else {
          lines.push({ description: item.description, quantity: item.quantity, unitPrice: item.unitPrice, discount: item.discountAmount, packageId: null, appointmentId: null });
        }
      }

      // Diskon: owner (invoice.discount) bebas hingga 100%; peran lain dibatasi pengaturan organisasi.
      let subtotal = 0;
      let discountTotal = 0;
      for (const l of lines) {
        const gross = l.quantity * l.unitPrice;
        if (l.discount > gross) throw badRequest(`Diskon melebihi nilai baris "${l.description}"`);
        if (l.discount > 0 && !can(ctx, 'invoice.discount')) {
          const max = Number(org.financeDiscountMaxPercent);
          if (max <= 0) throw forbidden('Diskon hanya dapat diberikan oleh owner');
          if (l.discount > (gross * max) / 100) throw forbidden(`Diskon melebihi batas ${max}% yang diizinkan untuk peran Anda`);
        }
        subtotal += gross;
        discountTotal += l.discount;
      }
      if (discountTotal > 0 && !body.discountReason) throw badRequest('Alasan diskon wajib diisi');

      const year = issuedOn.slice(0, 4);
      const seq = await nextCounter(db, ctx.orgId!, `invoice:${year}`);
      const invoiceNo = `${org.invoicePrefix}/${year}/${String(seq).padStart(5, '0')}`;
      const inv = await db.one<{ id: string }>(
        `INSERT INTO invoices (organization_id, invoice_no, patient_id, issued_on, due_on, subtotal, discount_total, total, discount_reason, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [ctx.orgId, invoiceNo, body.patientId, issuedOn, body.dueOn ?? null, subtotal, discountTotal, subtotal - discountTotal, discountTotal > 0 ? body.discountReason : null, body.notes, ctx.userId],
      );
      for (const l of lines) {
        await db.exec(
          `INSERT INTO invoice_items (organization_id, patient_id, invoice_id, description, quantity, unit_price, discount_amount, line_total, patient_package_id, appointment_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [ctx.orgId, body.patientId, inv.id, l.description, l.quantity, l.unitPrice, l.discount, l.quantity * l.unitPrice - l.discount, l.packageId, l.appointmentId],
        );
      }
      await audit(db, req, ctx, {
        action: 'invoice.dibuat',
        entityType: 'invoice',
        entityId: inv.id,
        meta: { nomor: invoiceNo, total: subtotal - discountTotal, diskon: discountTotal },
      });
      return { id: inv.id, invoiceNo, total: subtotal - discountTotal };
    });
    return reply.status(201).send(created);
  });

  const loadInvoice = (db: import('../db.ts').Db, orgId: string, id: string) =>
    db.maybe<Record<string, any>>(
      `SELECT ${INVOICE_FIELDS}, o.name AS organization_name
         FROM invoices i
         JOIN patients p ON p.organization_id = i.organization_id AND p.id = i.patient_id
         JOIN organizations o ON o.id = i.organization_id
        WHERE i.organization_id = $1 AND i.id = $2`,
      [orgId, id],
    );

  const loadDetail = async (db: import('../db.ts').Db, orgId: string, id: string): Promise<Record<string, any>> => {
    const inv = await loadInvoice(db, orgId, id);
    if (!inv) throw notFound('Invoice');
    const items = await db.many(
      `SELECT id, description, quantity, unit_price, discount_amount, line_total, patient_package_id, appointment_id
         FROM invoice_items WHERE organization_id = $1 AND invoice_id = $2 ORDER BY description`,
      [orgId, id],
    );
    const payments = await db.many(
      `SELECT pay.id, pay.receipt_no, pay.paid_on, pay.amount, pay.method, pay.status,
              coalesce((SELECT sum(r.amount) FROM refunds r WHERE r.organization_id = pay.organization_id AND r.payment_id = pay.id AND r.status = 'tercatat'), 0) AS refunded
         FROM payments pay WHERE pay.organization_id = $1 AND pay.invoice_id = $2 ORDER BY pay.paid_on`,
      [orgId, id],
    );
    return { ...inv, items, payments };
  };

  app.get('/invoices/:id', async (req) => {
    const ctx = needTenant(req, 'invoice.read');
    const id = idParam(req.params);
    return tenantTx(app, ctx, (db) => loadDetail(db, ctx.orgId!, id));
  });

  app.post('/invoices/:id/void', async (req) => {
    const ctx = needTenant(req, 'invoice.void');
    const id = idParam(req.params);
    const { reason } = parse(z.object({ reason: zText(5, 500) }), req.body);
    await tenantTx(app, ctx, async (db) => {
      const inv = await db.maybe<{ status: string }>(`SELECT status FROM invoices WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [ctx.orgId, id]);
      if (!inv) throw notFound('Invoice');
      if (inv.status === 'dibatalkan') throw conflict('Invoice ini sudah dibatalkan');
      const paid = await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM payments WHERE organization_id = $1 AND invoice_id = $2 AND status = 'tercatat'`,
        [ctx.orgId, id],
      );
      if (paid.n > 0) throw conflict('Invoice ini sudah memiliki pembayaran. Batalkan pembayarannya terlebih dahulu.');
      await db.exec(`UPDATE invoices SET status = 'dibatalkan', void_reason = $3, voided_at = now(), voided_by = $4 WHERE organization_id = $1 AND id = $2`, [
        ctx.orgId,
        id,
        reason,
        ctx.userId,
      ]);
      await db.exec(`UPDATE invoice_items SET active = false WHERE organization_id = $1 AND invoice_id = $2`, [ctx.orgId, id]);
      await audit(db, req, ctx, { action: 'invoice.dibatalkan', entityType: 'invoice', entityId: id });
    });
    return { ok: true };
  });

  app.get('/invoices/:id/pdf', async (req, reply) => {
    const ctx = needTenant(req, 'invoice.read');
    const id = idParam(req.params);
    const pdf = await tenantTx(app, ctx, async (db) => {
      const inv = await loadDetail(db, ctx.orgId!, id);
      const doc = await orgPdf(db, ctx, `INVOICE ${inv.invoiceNo}`, `Tanggal ${tgl(inv.issuedOn)}${inv.dueOn ? ` · jatuh tempo ${tgl(inv.dueOn)}` : ''}`);
      if (inv.status === 'dibatalkan') doc.stamp('DIBATALKAN');
      doc.keyValues([
        ['Ditagihkan kepada', `Wali dari ${inv.patientName} (${inv.patientCode})`],
        ['Status', { lunas: 'Lunas', sebagian: 'Dibayar sebagian', belum_dibayar: 'Belum dibayar', dibatalkan: 'Dibatalkan' }[inv.paymentStatus as string] ?? inv.paymentStatus],
      ]);
      doc.table(
        [
          { header: 'Keterangan', width: 0.44 },
          { header: 'Jml', width: 0.08, align: 'right' },
          { header: 'Harga', width: 0.16, align: 'right' },
          { header: 'Diskon', width: 0.14, align: 'right' },
          { header: 'Total', width: 0.18, align: 'right' },
        ],
        inv.items.map((it: any) => [it.description, String(it.quantity), rp(it.unitPrice), it.discountAmount ? rp(it.discountAmount) : '-', rp(it.lineTotal)]),
        { totalRow: ['Total tagihan', '', '', rp(inv.discountTotal), rp(inv.total)] },
      );
      if (inv.discountReason) doc.paragraph(`Alasan diskon: ${inv.discountReason}`, { muted: true });
      doc.amountBox('Sisa tagihan', rp(Math.max(0, inv.total - inv.paid)));
      if (inv.payments.length) {
        doc.heading('Pembayaran');
        doc.table(
          [
            { header: 'Tanggal', width: 0.2 },
            { header: 'Kuitansi', width: 0.3 },
            { header: 'Metode', width: 0.25 },
            { header: 'Nominal bersih', width: 0.25, align: 'right' },
          ],
          inv.payments.filter((p: any) => p.status === 'tercatat').map((p: any) => [tgl(p.paidOn), p.receiptNo, METHOD_LABEL[p.method], rp(p.amount - p.refunded)]),
        );
      }
      if (inv.notes) doc.paragraph(inv.notes, { muted: true });
      await audit(db, req, ctx, { action: 'invoice.pdf_diunduh', entityType: 'invoice', entityId: id });
      return { file: doc.toBuffer({ printedAt: printedAt(ctx) }), no: inv.invoiceNo };
    });
    return pdfReply(reply, pdf.file, `invoice-${pdf.no}.pdf`);
  });
}
