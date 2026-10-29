import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { needTenant, tenantTx, type AuthContext } from '../authz/context.ts';
import { dataScopes } from '../authz/permissions.ts';
import type { Db } from '../db.ts';
import { forbidden } from '../errors.ts';
import { parse, zRange } from '../http.ts';
import { invoicedSql, netPaidSql } from '../lib/money-sql.ts';
import { noteFinalLateSql, noteNotFinalSql, noteOverdueSql } from '../lib/note-deadline.ts';
import { METHOD_LABEL, orgPdf, printedAt, rp, tgl } from '../lib/pdf-format.ts';
import { pdfReply } from '../lib/pdf.ts';
import { buildXlsx, type Sheet } from '../lib/xlsx.ts';

// Definisi metrik ditampilkan bersama laporan agar angka tidak disalahartikan.
const OPERATIONAL_DEFINITIONS = {
  pasien_aktif: 'Jumlah pasien berstatus aktif saat ini (tidak dipengaruhi rentang tanggal).',
  pasien_baru: 'Pasien dengan tanggal pendaftaran di dalam rentang.',
  sesi: 'Jadwal dengan waktu mulai di dalam rentang, dikelompokkan menurut status terakhir.',
  pemakaian_paket: 'Total sesi paket yang terpakai pada rentang (pemakaian dikurangi pembatalan pemakaian, tanpa penyesuaian manual).',
  catatan_tertunda: 'Sesi selesai pada rentang yang belum memiliki catatan final (hanya terlihat oleh peran dengan akses catatan).',
  catatan_lewat_batas: 'Batas wajib catatan final adalah akhir bulan sesi. Lewat batas = belum final setelah bulan sesi berakhir; final terlambat = difinalkan setelah bulan sesi berakhir.',
};

const FINANCE_DEFINITIONS = {
  penerimaan: 'Jumlah pembayaran berstatus tercatat dengan tanggal bayar di dalam rentang (basis kas). Pembayaran yang dibatalkan tidak dihitung.',
  pengeluaran: 'Jumlah pengeluaran berstatus tercatat dengan tanggal di dalam rentang.',
  refund: 'Jumlah pengembalian dana (refund) berstatus tercatat dengan tanggal refund di dalam rentang.',
  selisih_kas: 'Penerimaan dikurangi refund dan pengeluaran tercatat pada rentang. BUKAN laba: belum memperhitungkan kewajiban honor yang belum dibayar, penyusutan, atau biaya yang tidak dicatat.',
  honor_dihitung: 'Honor terapis dari sesi selesai pada rentang yang belum ditandai dibayar.',
  honor_dibayar: 'Honor terapis dari sesi pada rentang yang sudah ditandai dibayar.',
  piutang: 'Sisa tagihan invoice aktif, serta sesi per-sesi selesai dan paket yang belum ditagihkan lewat invoice dan belum dibayar penuh (nilai bersih setelah refund, seluruh waktu).',
  qris: 'QRIS dicatat manual oleh petugas; sistem tidak memverifikasi transaksi ke penyedia pembayaran.',
};

const startOf = `($2::date)::timestamp AT TIME ZONE $4`;
const endOf = `($3::date + 1)::timestamp AT TIME ZONE $4`;

async function operational(db: Db, ctx: AuthContext, from: string, to: string) {
  const p = [ctx.orgId, from, to, ctx.timezone];
  // Tanpa akses catatan, RLS menyembunyikan semua catatan sehingga hitungan kepatuhan tidak bermakna.
  const withNotes = dataScopes(ctx.permissions).note !== 'none';
  const done = `a.status = 'selesai'`;
  const patients = await db.one(
    `SELECT count(*) FILTER (WHERE status = 'aktif') AS active,
            count(*) FILTER (WHERE registered_on BETWEEN $2 AND $3) AS new_in_range
       FROM patients WHERE organization_id = $1 AND $4::text IS NOT NULL`,
    p,
  );
  const sessionsByStatus = await db.many(
    `SELECT status, count(*) AS count FROM appointments
      WHERE organization_id = $1 AND starts_at >= ${startOf} AND starts_at < ${endOf}
      GROUP BY status ORDER BY status`,
    p,
  );
  const byTherapist = await db.many(
    `SELECT u.full_name AS therapist_name,
            count(*) FILTER (WHERE a.status = 'selesai') AS completed,
            count(*) FILTER (WHERE a.status = 'tidak_hadir') AS no_show,
            count(*) FILTER (WHERE a.status = 'dibatalkan') AS cancelled,
            count(*) FILTER (WHERE a.status = 'terjadwal') AS scheduled
            ${
              withNotes
                ? `, count(*) FILTER (WHERE ${done} AND ${noteNotFinalSql}) AS notes_pending,
                     count(*) FILTER (WHERE ${done} AND ${noteOverdueSql('$4')}) AS notes_overdue,
                     count(*) FILTER (WHERE ${done} AND ${noteFinalLateSql('$4')}) AS notes_late`
                : ''
            }
       FROM appointments a
       JOIN memberships m ON m.organization_id = a.organization_id AND m.id = a.therapist_member_id
       JOIN users u ON u.id = m.user_id
       LEFT JOIN therapy_notes n ON n.organization_id = a.organization_id AND n.appointment_id = a.id
      WHERE a.organization_id = $1 AND a.starts_at >= ${startOf} AND a.starts_at < ${endOf}
      GROUP BY u.full_name ORDER BY u.full_name`,
    p,
  );
  const byService = await db.many(
    `SELECT coalesce(s.name, 'Tanpa layanan') AS service_name, count(*) FILTER (WHERE a.status = 'selesai') AS completed
       FROM appointments a
       LEFT JOIN therapy_services s ON s.organization_id = a.organization_id AND s.id = a.service_id
      WHERE a.organization_id = $1 AND a.starts_at >= ${startOf} AND a.starts_at < ${endOf}
      GROUP BY 1 ORDER BY 1`,
    p,
  );
  const packageUsage = await db.one(
    `SELECT coalesce(sum(sessions_delta) FILTER (WHERE kind IN ('pemakaian', 'pembatalan_pemakaian')), 0) AS sessions_used
       FROM package_ledger
      WHERE organization_id = $1 AND created_at >= ${startOf} AND created_at < ${endOf}`,
    p,
  );
  const notes = withNotes
    ? await db.one<{ pending: number; overdue: number; late: number }>(
        `SELECT count(*) FILTER (WHERE ${noteNotFinalSql}) AS pending,
                count(*) FILTER (WHERE ${noteOverdueSql('$4')}) AS overdue,
                count(*) FILTER (WHERE ${noteFinalLateSql('$4')}) AS late
           FROM appointments a
           LEFT JOIN therapy_notes n ON n.organization_id = a.organization_id AND n.appointment_id = a.id
          WHERE a.organization_id = $1 AND ${done} AND a.starts_at >= ${startOf} AND a.starts_at < ${endOf}`,
        p,
      )
    : null;
  return {
    patients,
    sessionsByStatus,
    byTherapist,
    byService,
    packageUsage,
    pendingNotes: notes?.pending ?? null,
    overdueNotes: notes?.overdue ?? null,
    lateNotes: notes?.late ?? null,
  };
}

async function finance(db: Db, ctx: AuthContext, from: string, to: string) {
  const p = [ctx.orgId, from, to];
  const payments = await db.one<{ total: number; count: number; voided: number }>(
    `SELECT coalesce(sum(amount) FILTER (WHERE status = 'tercatat'), 0) AS total,
            count(*) FILTER (WHERE status = 'tercatat') AS count,
            count(*) FILTER (WHERE status = 'dibatalkan') AS voided
       FROM payments WHERE organization_id = $1 AND paid_on BETWEEN $2 AND $3`,
    p,
  );
  const byMethod = await db.many(
    `SELECT method, coalesce(sum(amount), 0) AS total, count(*) AS count
       FROM payments WHERE organization_id = $1 AND paid_on BETWEEN $2 AND $3 AND status = 'tercatat'
      GROUP BY method ORDER BY method`,
    p,
  );
  const expenses = await db.one<{ total: number }>(
    `SELECT coalesce(sum(amount), 0) AS total FROM expenses
      WHERE organization_id = $1 AND spent_on BETWEEN $2 AND $3 AND status = 'tercatat'`,
    p,
  );
  const expensesByCategory = await db.many(
    `SELECT category, coalesce(sum(amount), 0) AS total FROM expenses
      WHERE organization_id = $1 AND spent_on BETWEEN $2 AND $3 AND status = 'tercatat'
      GROUP BY category ORDER BY total DESC`,
    p,
  );
  const refunds = await db.one<{ total: number; count: number }>(
    `SELECT coalesce(sum(amount), 0) AS total, count(*) AS count FROM refunds
      WHERE organization_id = $1 AND refunded_on BETWEEN $2 AND $3 AND status = 'tercatat'`,
    p,
  );
  const compensation = await db.one(
    `SELECT coalesce(sum(amount) FILTER (WHERE status = 'dihitung'), 0) AS unpaid,
            coalesce(sum(amount) FILTER (WHERE status = 'dibayar'), 0) AS paid
       FROM therapist_compensations WHERE organization_id = $1 AND session_date BETWEEN $2 AND $3`,
    p,
  );
  const receivables = await db.one<{ sessions: number; packages: number; invoices: number }>(
    `SELECT
       (SELECT coalesce(sum(a.price - ${netPaidSql('a', 'appointment_id')}), 0) FROM appointments a
         WHERE a.organization_id = $1 AND a.status = 'selesai' AND a.billing = 'per_sesi' AND a.price > 0
           AND NOT ${invoicedSql('a', 'appointment_id')} AND a.price > ${netPaidSql('a', 'appointment_id')}) AS sessions,
       (SELECT coalesce(sum(pp.price - ${netPaidSql('pp', 'patient_package_id')}), 0) FROM patient_packages pp
         WHERE pp.organization_id = $1 AND pp.status <> 'dibatalkan' AND pp.price > 0
           AND NOT ${invoicedSql('pp', 'patient_package_id')} AND pp.price > ${netPaidSql('pp', 'patient_package_id')}) AS packages,
       (SELECT coalesce(sum(i.total - ${netPaidSql('i', 'invoice_id')}), 0) FROM invoices i
         WHERE i.organization_id = $1 AND i.status = 'terbit' AND i.total > ${netPaidSql('i', 'invoice_id')}) AS invoices`,
    [ctx.orgId],
  );
  return {
    payments,
    byMethod,
    expenses,
    expensesByCategory,
    refunds,
    cashDifference: payments.total - refunds.total - expenses.total,
    compensation,
    receivables,
  };
}

const kindQuery = z.object({ kind: z.enum(['operasional', 'keuangan']) });

export async function reportRoutes(app: FastifyInstance) {
  app.get('/reports/operational', async (req) => {
    const ctx = needTenant(req, 'report.operational');
    const q = parse(zRange, req.query);
    const data = await tenantTx(app, ctx, (db) => operational(db, ctx, q.from, q.to));
    return { range: q, ...data, definitions: OPERATIONAL_DEFINITIONS };
  });

  app.get('/reports/finance', async (req) => {
    const ctx = needTenant(req, 'report.finance');
    const q = parse(zRange, req.query);
    const data = await tenantTx(app, ctx, (db) => finance(db, ctx, q.from, q.to));
    return { range: q, ...data, definitions: FINANCE_DEFINITIONS };
  });

  // Ekspor PDF ringkasan laporan (data dari fungsi yang sama dengan tampilan layar).
  app.get('/reports/:kind/pdf', async (req, reply) => {
    const { kind } = parse(kindQuery, req.params);
    const ctx = needTenant(req, 'report.export');
    if (kind === 'operasional' && !ctx.permissions.has('report.operational')) throw forbidden();
    if (kind === 'keuangan' && !ctx.permissions.has('report.finance')) throw forbidden();
    const q = parse(zRange, req.query);
    const file = await tenantTx(app, ctx, async (db) => {
      const sub = `${tgl(q.from)} - ${tgl(q.to)}`;
      const doc = await orgPdf(db, ctx, kind === 'operasional' ? 'Laporan Operasional' : 'Laporan Keuangan', sub);
      if (kind === 'operasional') {
        const d = await operational(db, ctx, q.from, q.to);
        const st = Object.fromEntries(d.sessionsByStatus.map((x: any) => [x.status, x.count]));
        doc.heading('Ringkasan').keyValues([
          ['Pasien aktif', String((d.patients as any).active)],
          ['Pasien baru', String((d.patients as any).newInRange)],
          ['Sesi selesai', String(st.selesai ?? 0)],
          ['Tidak hadir / dibatalkan', `${st.tidak_hadir ?? 0} / ${st.dibatalkan ?? 0}`],
          ['Sesi paket terpakai', String((d.packageUsage as any).sessionsUsed)],
          ...(d.pendingNotes !== null
            ? ([
                ['Sesi tanpa catatan final', String(d.pendingNotes)],
                ['Catatan lewat batas / final terlambat', `${d.overdueNotes} / ${d.lateNotes}`],
              ] as [string, string][])
            : []),
        ]);
        if (d.pendingNotes !== null) {
          doc.heading('Per terapis').table(
            [
              { header: 'Terapis', width: 0.28 },
              { header: 'Selesai', width: 0.1, align: 'right' },
              { header: 'Tdk hadir', width: 0.1, align: 'right' },
              { header: 'Batal', width: 0.08, align: 'right' },
              { header: 'Terjadwal', width: 0.1, align: 'right' },
              { header: 'Blm final', width: 0.11, align: 'right' },
              { header: 'Lewat batas', width: 0.12, align: 'right' },
              { header: 'Final telat', width: 0.11, align: 'right' },
            ],
            d.byTherapist.map((t: any) => [
              t.therapistName,
              String(t.completed),
              String(t.noShow),
              String(t.cancelled),
              String(t.scheduled),
              String(t.notesPending),
              String(t.notesOverdue),
              String(t.notesLate),
            ]),
          );
        } else {
          doc.heading('Per terapis').table(
            [{ header: 'Terapis', width: 0.4 }, { header: 'Selesai', width: 0.15, align: 'right' }, { header: 'Tidak hadir', width: 0.15, align: 'right' }, { header: 'Batal', width: 0.15, align: 'right' }, { header: 'Terjadwal', width: 0.15, align: 'right' }],
            d.byTherapist.map((t: any) => [t.therapistName, String(t.completed), String(t.noShow), String(t.cancelled), String(t.scheduled)]),
          );
        }
        doc.heading('Sesi selesai per layanan').table(
          [{ header: 'Layanan', width: 0.7 }, { header: 'Selesai', width: 0.3, align: 'right' }],
          d.byService.map((x: any) => [x.serviceName, String(x.completed)]),
        );
        doc.heading('Definisi');
        for (const [k, v] of Object.entries(OPERATIONAL_DEFINITIONS)) doc.paragraph(`${k.replaceAll('_', ' ')}: ${v}`, { size: 8, muted: true });
      } else {
        const d = await finance(db, ctx, q.from, q.to);
        doc.heading('Ringkasan (basis kas)').keyValues([
          ['Penerimaan', `${rp(d.payments.total)} (${d.payments.count} transaksi)`],
          ['Refund', `${rp(d.refunds.total)} (${d.refunds.count} transaksi)`],
          ['Pengeluaran', rp(d.expenses.total)],
          ['Selisih kas (bukan laba)', rp(d.cashDifference)],
          ['Piutang saat ini', rp(d.receivables.sessions + d.receivables.packages + d.receivables.invoices)],
          ['Honor belum / sudah dibayar', `${rp((d.compensation as any).unpaid)} / ${rp((d.compensation as any).paid)}`],
        ]);
        doc.heading('Penerimaan per metode').table(
          [{ header: 'Metode', width: 0.5 }, { header: 'Transaksi', width: 0.2, align: 'right' }, { header: 'Total', width: 0.3, align: 'right' }],
          d.byMethod.map((m: any) => [METHOD_LABEL[m.method], String(m.count), rp(m.total)]),
        );
        doc.heading('Pengeluaran per kategori').table(
          [{ header: 'Kategori', width: 0.7 }, { header: 'Total', width: 0.3, align: 'right' }],
          d.expensesByCategory.map((c: any) => [c.category, rp(c.total)]),
        );
        doc.heading('Definisi');
        for (const [k, v] of Object.entries(FINANCE_DEFINITIONS)) doc.paragraph(`${k.replaceAll('_', ' ')}: ${v}`, { size: 8, muted: true });
      }
      await audit(db, req, ctx, { action: 'laporan.diekspor', entityType: 'report', entityId: `${kind}-pdf`, meta: { dari: q.from, sampai: q.to } });
      return doc.toBuffer({ printedAt: printedAt(ctx) });
    });
    return pdfReply(reply, file, `laporan-${kind}-${q.from}_${q.to}.pdf`);
  });

  // Ekspor Excel. Data diambil ulang di server dengan filter organisasi aktif.
  app.get('/reports/:kind/export', async (req, reply) => {
    const { kind } = parse(kindQuery, req.params);
    const ctx = needTenant(req, 'report.export');
    if (kind === 'operasional' && !ctx.permissions.has('report.operational')) throw forbidden();
    if (kind === 'keuangan' && !ctx.permissions.has('report.finance')) throw forbidden();
    const q = parse(zRange, req.query);

    const sheets = await tenantTx(app, ctx, async (db): Promise<Sheet[]> => {
      const p = [ctx.orgId, q.from, q.to, ctx.timezone];
      let result: Sheet[];
      if (kind === 'operasional') {
        const withNotes = dataScopes(ctx.permissions).note !== 'none';
        const noteCol = `CASE WHEN a.status <> 'selesai' THEN NULL
                              WHEN ${noteFinalLateSql('$4')} THEN 'final (terlambat)'
                              WHEN n.status = 'final' THEN 'final'
                              WHEN ${noteOverdueSql('$4')} THEN 'lewat batas'
                              WHEN n.id IS NULL THEN 'belum ada'
                              ELSE 'draf' END`;
        const sessions = await db.many<Record<string, string | number | null>>(
          `SELECT to_char(a.starts_at AT TIME ZONE $4, 'YYYY-MM-DD') AS d, to_char(a.starts_at AT TIME ZONE $4, 'HH24:MI') AS t,
                  p.patient_code, p.full_name AS patient_name, u.full_name AS therapist_name, s.name AS service_name,
                  a.duration_minutes, a.status, a.billing, ${withNotes ? noteCol : 'NULL'} AS note
             FROM appointments a
             LEFT JOIN therapy_notes n ON n.organization_id = a.organization_id AND n.appointment_id = a.id
             JOIN patients p ON p.organization_id = a.organization_id AND p.id = a.patient_id
             JOIN memberships m ON m.organization_id = a.organization_id AND m.id = a.therapist_member_id
             JOIN users u ON u.id = m.user_id
             LEFT JOIN therapy_services s ON s.organization_id = a.organization_id AND s.id = a.service_id
            WHERE a.organization_id = $1 AND a.starts_at >= ${startOf} AND a.starts_at < ${endOf}
            ORDER BY a.starts_at`,
          p,
        );
        result = [
          {
            name: 'Sesi',
            columns: [
              { header: 'Tanggal', width: 12 },
              { header: 'Jam', width: 8 },
              { header: 'Kode Pasien', width: 12 },
              { header: 'Nama Pasien', width: 28 },
              { header: 'Terapis', width: 24 },
              { header: 'Layanan', width: 22 },
              { header: 'Durasi (menit)', width: 14 },
              { header: 'Status', width: 14 },
              { header: 'Tagihan', width: 12 },
              ...(withNotes ? [{ header: 'Catatan', width: 18 }] : []),
            ],
            rows: sessions.map((r) => [
              r.d,
              r.t,
              r.patientCode,
              r.patientName,
              r.therapistName,
              r.serviceName,
              r.durationMinutes,
              r.status,
              r.billing,
              ...(withNotes ? [r.note] : []),
            ]),
          },
        ];
      } else {
        const payments = await db.many<Record<string, string | number | null>>(
          `SELECT pay.paid_on, pay.receipt_no, p.patient_code, p.full_name AS patient_name, pay.method, pay.amount, pay.status, pay.reference
             FROM payments pay JOIN patients p ON p.organization_id = pay.organization_id AND p.id = pay.patient_id
            WHERE pay.organization_id = $1 AND pay.paid_on BETWEEN $2 AND $3 AND $4::text IS NOT NULL
            ORDER BY pay.paid_on, pay.receipt_no`,
          p,
        );
        const expenses = await db.many<Record<string, string | number | null>>(
          `SELECT spent_on, category, description, method, amount, status FROM expenses
            WHERE organization_id = $1 AND spent_on BETWEEN $2 AND $3 AND $4::text IS NOT NULL ORDER BY spent_on`,
          p,
        );
        const comp = await db.many<Record<string, string | number | null>>(
          `SELECT c.session_date, u.full_name AS therapist_name, c.amount, c.status, c.paid_on
             FROM therapist_compensations c
             JOIN memberships m ON m.organization_id = c.organization_id AND m.id = c.member_id
             JOIN users u ON u.id = m.user_id
            WHERE c.organization_id = $1 AND c.session_date BETWEEN $2 AND $3 AND $4::text IS NOT NULL
            ORDER BY u.full_name, c.session_date`,
          p,
        );
        result = [
          {
            name: 'Pembayaran',
            columns: [
              { header: 'Tanggal', width: 12 },
              { header: 'No. Kuitansi', width: 18 },
              { header: 'Kode Pasien', width: 12 },
              { header: 'Nama Pasien', width: 28 },
              { header: 'Metode', width: 10 },
              { header: 'Nominal (Rp)', width: 16, money: true },
              { header: 'Status', width: 12 },
              { header: 'Referensi', width: 20 },
            ],
            rows: payments.map((r) => [r.paidOn, r.receiptNo, r.patientCode, r.patientName, r.method === 'qris' ? 'qris (manual)' : r.method, r.amount, r.status, r.reference]),
          },
          {
            name: 'Pengeluaran',
            columns: [
              { header: 'Tanggal', width: 12 },
              { header: 'Kategori', width: 18 },
              { header: 'Keterangan', width: 36 },
              { header: 'Metode', width: 10 },
              { header: 'Nominal (Rp)', width: 16, money: true },
              { header: 'Status', width: 12 },
            ],
            rows: expenses.map((r) => [r.spentOn, r.category, r.description, r.method, r.amount, r.status]),
          },
          {
            name: 'Honor Terapis',
            columns: [
              { header: 'Tanggal Sesi', width: 12 },
              { header: 'Terapis', width: 24 },
              { header: 'Nominal (Rp)', width: 16, money: true },
              { header: 'Status', width: 12 },
              { header: 'Tanggal Bayar', width: 14 },
            ],
            rows: comp.map((r) => [r.sessionDate, r.therapistName, r.amount, r.status, r.paidOn]),
          },
        ];
      }
      await audit(db, req, ctx, { action: 'laporan.diekspor', entityType: 'report', entityId: kind, meta: { dari: q.from, sampai: q.to } });
      return result;
    });

    const file = buildXlsx(sheets);
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="laporan-${kind}-${q.from}_${q.to}.xlsx"`)
      .send(file);
  });
}
