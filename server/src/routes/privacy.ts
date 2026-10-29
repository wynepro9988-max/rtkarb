import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { needTenant, tenantTx } from '../authz/context.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { idParam, parse, zDate, zOptText, zText } from '../http.ts';
import { METHOD_LABEL, orgPdf, printedAt, rp, tgl, waktu } from '../lib/pdf-format.ts';
import { pdfReply } from '../lib/pdf.ts';
import { requirePatient } from './patients.ts';

// Hak subjek data (UU PDP) untuk data anak: register permintaan wali, ekspor data (hak akses),
// anonimisasi (hak penghapusan), dan daftar kandidat retensi. Tidak ada penghapusan otomatis.
const requestBody = z.object({
  patientId: z.uuid(),
  kind: z.enum(['akses', 'koreksi', 'hapus']),
  requesterName: zText(2, 150),
  requesterRelation: zOptText(60),
  receivedOn: zDate,
  details: zOptText(2000),
});

export async function privacyRoutes(app: FastifyInstance) {
  app.get('/privacy/requests', async (req) => {
    const ctx = needTenant(req, 'privacy.manage');
    return tenantTx(app, ctx, (db) =>
      db.many(
        `SELECT r.id, r.patient_id, p.full_name AS patient_name, p.patient_code, r.kind, r.requester_name, r.requester_relation,
                r.received_on, r.details, r.status, r.resolution, r.handled_at, u.full_name AS handled_by_name
           FROM data_requests r
           JOIN patients p ON p.organization_id = r.organization_id AND p.id = r.patient_id
           LEFT JOIN users u ON u.id = r.handled_by
          WHERE r.organization_id = $1 ORDER BY r.received_on DESC, r.created_at DESC LIMIT 200`,
        [ctx.orgId],
      ),
    );
  });

  app.post('/privacy/requests', async (req, reply) => {
    const ctx = needTenant(req, 'privacy.manage');
    const body = parse(requestBody, req.body);
    const row = await tenantTx(app, ctx, async (db) => {
      await requirePatient(db, ctx.orgId!, body.patientId);
      const r = await db.one<{ id: string }>(
        `INSERT INTO data_requests (organization_id, patient_id, kind, requester_name, requester_relation, received_on, details, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [ctx.orgId, body.patientId, body.kind, body.requesterName, body.requesterRelation, body.receivedOn, body.details, ctx.userId],
      );
      await audit(db, req, ctx, { action: 'privasi.permintaan_dicatat', entityType: 'data_request', entityId: r.id, meta: { jenis: body.kind } });
      return r;
    });
    return reply.status(201).send(row);
  });

  app.patch('/privacy/requests/:id', async (req) => {
    const ctx = needTenant(req, 'privacy.manage');
    const id = idParam(req.params);
    const body = parse(z.object({ status: z.enum(['diproses', 'selesai', 'ditolak']), resolution: zOptText(2000) }), req.body);
    if (body.status !== 'diproses' && !body.resolution) throw badRequest('Tuliskan hasil/alasan penyelesaian');
    await tenantTx(app, ctx, async (db) => {
      const n = await db.exec(
        `UPDATE data_requests SET status = $3, resolution = $4, handled_by = $5, handled_at = now() WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, body.status, body.resolution, ctx.userId],
      );
      if (n === 0) throw notFound('Permintaan');
      await audit(db, req, ctx, { action: 'privasi.permintaan_diperbarui', entityType: 'data_request', entityId: id, meta: { status: body.status } });
    });
    return { ok: true };
  });

  // Hak akses: ringkasan seluruh data pasien dalam PDF (untuk diserahkan kepada wali).
  app.get('/patients/:id/export.pdf', async (req, reply) => {
    const ctx = needTenant(req, 'privacy.manage');
    const id = idParam(req.params);
    const out = await tenantTx(app, ctx, async (db) => {
      const tz = ctx.timezone;
      const p = await db.maybe<Record<string, any>>(
        `SELECT patient_code, full_name, nickname, birth_date, sex, status, registered_on, address, admin_notes, anonymized_at
           FROM patients WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id],
      );
      if (!p) throw notFound('Pasien');
      const q = <T = Record<string, any>>(sql: string) => db.many<T>(sql, [ctx.orgId, id, tz]);
      const guardians = await q(`SELECT full_name, relationship, phone, email, address FROM guardians WHERE organization_id = $1 AND patient_id = $2 AND $3::text IS NOT NULL ORDER BY is_primary DESC`);
      const appts = await q(
        `SELECT to_char(a.starts_at AT TIME ZONE $3, 'DD-MM-YYYY HH24:MI') AS at, s.name AS service, u.full_name AS therapist, a.status
           FROM appointments a JOIN memberships m ON m.organization_id = a.organization_id AND m.id = a.therapist_member_id
           JOIN users u ON u.id = m.user_id LEFT JOIN therapy_services s ON s.organization_id = a.organization_id AND s.id = a.service_id
          WHERE a.organization_id = $1 AND a.patient_id = $2 ORDER BY a.starts_at`,
      );
      const programs = await q(
        `SELECT pr.title, pr.status, pr.start_date, pr.summary,
                (SELECT string_agg('- ' || g.description || ' [' || g.status || ']', E'\\n' ORDER BY g.sort_order) FROM program_goals g
                  WHERE g.organization_id = pr.organization_id AND g.program_id = pr.id) AS goals
           FROM therapy_programs pr WHERE pr.organization_id = $1 AND pr.patient_id = $2 AND $3::text IS NOT NULL ORDER BY pr.start_date`,
      );
      const notes = await q(
        `SELECT n.note_type, n.status, n.objectives, n.activities, n.observations, n.home_program, n.next_plan, u.full_name AS author,
                to_char(coalesce(a.starts_at, n.created_at) AT TIME ZONE $3, 'DD-MM-YYYY') AS at
           FROM therapy_notes n JOIN memberships m ON m.organization_id = n.organization_id AND m.id = n.author_member_id
           JOIN users u ON u.id = m.user_id LEFT JOIN appointments a ON a.organization_id = n.organization_id AND a.id = n.appointment_id
          WHERE n.organization_id = $1 AND n.patient_id = $2 ORDER BY coalesce(a.starts_at, n.created_at)`,
      );
      const payments = await q(
        `SELECT receipt_no, paid_on, amount, method, status FROM payments WHERE organization_id = $1 AND patient_id = $2 AND $3::text IS NOT NULL ORDER BY paid_on`,
      );
      const docs = await q(
        `SELECT title, category, uploaded_at FROM patient_documents WHERE organization_id = $1 AND patient_id = $2 AND $3::text IS NOT NULL ORDER BY uploaded_at`,
      );

      const doc = await orgPdf(db, ctx, `Ringkasan Data Pasien ${p.patientCode}`, 'Disusun atas permintaan hak akses data pribadi', true);
      doc.heading('Identitas').keyValues([
        ['Nama', p.fullName],
        ['Nama panggilan', p.nickname ?? '-'],
        ['Tanggal lahir', tgl(p.birthDate)],
        ['Jenis kelamin', p.sex === 'L' ? 'Laki-laki' : p.sex === 'P' ? 'Perempuan' : '-'],
        ['Terdaftar', tgl(p.registeredOn)],
        ['Alamat', p.address ?? '-'],
        ['Catatan administrasi', p.adminNotes ?? '-'],
      ]);
      doc.heading('Wali');
      doc.table(
        [{ header: 'Nama', width: 0.28 }, { header: 'Hubungan', width: 0.16 }, { header: 'Telepon', width: 0.2 }, { header: 'Email / alamat', width: 0.36 }],
        guardians.map((g) => [g.fullName, g.relationship, g.phone ?? '-', [g.email, g.address].filter(Boolean).join(' / ') || '-']),
      );
      doc.heading('Program terapi');
      if (programs.length === 0) doc.paragraph('Tidak ada.', { muted: true });
      for (const pr of programs) doc.paragraph(`${pr.title} (${pr.status}, mulai ${tgl(pr.startDate)})${pr.summary ? `\n${pr.summary}` : ''}${pr.goals ? `\n${pr.goals}` : ''}`);
      doc.heading('Riwayat jadwal');
      doc.table(
        [{ header: 'Waktu', width: 0.22 }, { header: 'Layanan', width: 0.3 }, { header: 'Terapis', width: 0.3 }, { header: 'Status', width: 0.18 }],
        appts.map((a) => [a.at, a.service ?? '-', a.therapist, a.status]),
      );
      doc.heading('Catatan terapi');
      if (notes.length === 0) doc.paragraph('Tidak ada.', { muted: true });
      for (const n of notes) {
        doc.paragraph(`${n.at} - ${n.noteType} (${n.status}) oleh ${n.author}`, { bold: true });
        const parts = [
          ['Tujuan', n.objectives],
          ['Aktivitas', n.activities],
          ['Observasi', n.observations],
          ['Program di rumah', n.homeProgram],
          ['Rencana', n.nextPlan],
        ].filter(([, v]) => v);
        doc.paragraph(parts.map(([k, v]) => `${k}: ${v}`).join('\n') || '-');
      }
      doc.heading('Pembayaran');
      doc.table(
        [{ header: 'Tanggal', width: 0.2 }, { header: 'Kuitansi', width: 0.3 }, { header: 'Metode', width: 0.25 }, { header: 'Nominal', width: 0.25, align: 'right' }],
        payments.map((x) => [tgl(x.paidOn), `${x.receiptNo}${x.status === 'dibatalkan' ? ' (batal)' : ''}`, METHOD_LABEL[x.method], rp(x.amount)]),
      );
      doc.heading('Dokumen tersimpan');
      doc.table(
        [{ header: 'Judul', width: 0.5 }, { header: 'Kategori', width: 0.2 }, { header: 'Diunggah', width: 0.3 }],
        docs.map((d) => [d.title, d.category, waktu(d.uploadedAt, tz)]),
      );
      await audit(db, req, ctx, { action: 'privasi.ekspor_data', entityType: 'patient', entityId: id });
      return { file: doc.toBuffer({ printedAt: printedAt(ctx) }), code: p.patientCode as string };
    });
    return pdfReply(reply, out.file, `data-pasien-${out.code}.pdf`);
  });

  // Hak penghapusan: anonimisasi terkendali. Konfirmasi dengan mengetik ulang kode pasien.
  app.post('/patients/:id/anonymize', async (req) => {
    const ctx = needTenant(req, 'privacy.manage');
    const id = idParam(req.params);
    const body = parse(
      z.object({ mode: z.enum(['identitas', 'penuh']), confirmCode: z.string().trim().min(1).max(40), reason: zText(10, 500), requestId: z.uuid().nullish() }),
      req.body,
    );
    const result = await tenantTx(app, ctx, async (db) => {
      const p = await db.maybe<{ patientCode: string; anonymizedAt: Date | null }>(
        `SELECT patient_code, anonymized_at FROM patients WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id],
      );
      if (!p) throw notFound('Pasien');
      if (p.anonymizedAt) throw conflict('Data pasien ini sudah dianonimkan');
      if (body.confirmCode !== p.patientCode) throw badRequest('Kode konfirmasi tidak sama dengan kode pasien');
      const pending = await db.maybe(`SELECT 1 FROM appointments WHERE organization_id = $1 AND patient_id = $2 AND status = 'terjadwal' LIMIT 1`, [ctx.orgId, id]);
      if (pending) throw conflict('Masih ada jadwal terjadwal. Batalkan jadwal tersebut terlebih dahulu.');
      const { keys } = await db.one<{ keys: string[] }>(`SELECT anonymize_patient($1, $2) AS keys`, [id, body.mode]);
      if (body.requestId) {
        await db.exec(
          `UPDATE data_requests SET status = 'selesai', resolution = $3, handled_by = $4, handled_at = now()
            WHERE organization_id = $1 AND id = $2`,
          [ctx.orgId, body.requestId, `Dianonimkan (mode ${body.mode})`, ctx.userId],
        );
      }
      await audit(db, req, ctx, {
        action: 'privasi.anonimisasi',
        entityType: 'patient',
        entityId: id,
        meta: { mode: body.mode, berkas: keys.length, permintaan_id: body.requestId ?? null },
      });
      return keys;
    });
    // Berkas dihapus setelah transaksi berhasil.
    let failed = 0;
    for (const key of result) {
      try {
        await app.fileStore.remove(key);
      } catch (err) {
        failed++;
        req.log.error({ err: { message: (err as Error).message } }, 'gagal menghapus berkas saat anonimisasi');
      }
    }
    return { ok: true, filesRemoved: result.length - failed, filesFailed: failed };
  });

  // Kandidat retensi: pasien tidak aktif yang aktivitas terakhirnya lebih lama dari batas organisasi.
  app.get('/privacy/retention', async (req) => {
    const ctx = needTenant(req, 'privacy.manage');
    return tenantTx(app, ctx, async (db) => {
      const org = await db.one<{ retentionYears: number | null }>(`SELECT retention_years FROM organizations WHERE id = $1`, [ctx.orgId]);
      if (!org.retentionYears) return { configured: false, retentionYears: null, items: [] };
      const items = await db.many(
        `SELECT * FROM (
           SELECT p.id, p.patient_code, p.full_name, p.status,
                  greatest(p.registered_on,
                           (SELECT max((a.starts_at AT TIME ZONE $3)::date) FROM appointments a WHERE a.organization_id = p.organization_id AND a.patient_id = p.id),
                           (SELECT max(pay.paid_on) FROM payments pay WHERE pay.organization_id = p.organization_id AND pay.patient_id = p.id)) AS last_activity
             FROM patients p
            WHERE p.organization_id = $1 AND p.status <> 'aktif' AND p.anonymized_at IS NULL) x
          WHERE last_activity < (now() AT TIME ZONE $3)::date - make_interval(years => $2)
          ORDER BY last_activity`,
        [ctx.orgId, org.retentionYears, ctx.timezone],
      );
      return { configured: true, retentionYears: org.retentionYears, items };
    });
  });
}
