import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { needPortal, portalAuditTx, portalTx } from '../authz/context.ts';
import { notFound } from '../errors.ts';
import { parse } from '../http.ts';
import { netPaidSql } from '../lib/money-sql.ts';

const UPCOMING_LIMIT = 30;
const HISTORY_LIMIT = 40;
const INVOICE_LIMIT = 24;
const NOTE_LIMIT = 50;

// Kolom jadwal yang boleh dilihat orang tua: tanpa catatan admin, alasan pembatalan, dan harga.
const SESSION_FIELDS = `a.id, a.patient_id, a.status, a.duration_minutes,
  to_char(a.starts_at AT TIME ZONE $3, 'YYYY-MM-DD') AS local_date,
  to_char(a.starts_at AT TIME ZONE $3, 'HH24:MI') AS local_time,
  s.name AS service_name, u.full_name AS therapist_name`;
const SESSION_JOINS = `
  JOIN memberships m ON m.organization_id = a.organization_id AND m.id = a.therapist_member_id
  JOIN users u ON u.id = m.user_id
  LEFT JOIN therapy_services s ON s.organization_id = a.organization_id AND s.id = a.service_id`;

export async function portalRoutes(app: FastifyInstance) {
  app.get('/portal', async (req) => {
    const ctx = needPortal(req);
    return portalTx(app, ctx, async (db) => {
      const children = await db.many<{ id: string }>(
        `SELECT p.id, p.full_name, p.nickname, p.patient_code
           FROM patients p
          WHERE p.organization_id = $1
            AND EXISTS (SELECT 1 FROM guardians g
                         WHERE g.organization_id = p.organization_id AND g.patient_id = p.id AND g.member_id = $2)
          ORDER BY p.full_name`,
        [ctx.orgId, ctx.memberId],
      );
      if (children.length === 0) return { children, upcoming: [], history: [], attendance: [], packages: [], invoices: [] };
      const ids = children.map((c) => c.id);
      const params = [ctx.orgId, ids, ctx.timezone];

      const upcoming = await db.many(
        `SELECT ${SESSION_FIELDS} FROM appointments a ${SESSION_JOINS}
          WHERE a.organization_id = $1 AND a.patient_id = ANY($2::uuid[]) AND a.status = 'terjadwal' AND a.starts_at >= now()
          ORDER BY a.starts_at LIMIT ${UPCOMING_LIMIT}`,
        params,
      );
      const history = await db.many(
        `SELECT ${SESSION_FIELDS} FROM appointments a ${SESSION_JOINS}
          WHERE a.organization_id = $1 AND a.patient_id = ANY($2::uuid[]) AND a.starts_at < now()
          ORDER BY a.starts_at DESC LIMIT ${HISTORY_LIMIT}`,
        params,
      );
      // Kehadiran bulan berjalan menurut zona waktu organisasi.
      const attendance = await db.many(
        `SELECT a.patient_id,
                count(*) FILTER (WHERE a.status = 'selesai')::int AS attended,
                count(*) FILTER (WHERE a.status = 'tidak_hadir')::int AS missed
           FROM appointments a
          WHERE a.organization_id = $1 AND a.patient_id = ANY($2::uuid[])
            AND to_char(a.starts_at AT TIME ZONE $3, 'YYYY-MM') = to_char(now() AT TIME ZONE $3, 'YYYY-MM')
          GROUP BY a.patient_id`,
        params,
      );
      const packages = await db.many(
        `SELECT pp.id, pp.patient_id, pp.name, pp.sessions_total, pp.sessions_used, pp.expires_on
           FROM patient_packages pp
          WHERE pp.organization_id = $1 AND pp.patient_id = ANY($2::uuid[]) AND pp.status = 'aktif'
          ORDER BY pp.purchased_on DESC`,
        [ctx.orgId, ids],
      );
      const invoices = await db.many(
        `SELECT i.id, i.patient_id, i.invoice_no, i.issued_on, i.due_on, i.total, ${netPaidSql('i', 'invoice_id')} AS paid
           FROM invoices i
          WHERE i.organization_id = $1 AND i.patient_id = ANY($2::uuid[]) AND i.status = 'terbit'
          ORDER BY i.issued_on DESC, i.created_at DESC LIMIT ${INVOICE_LIMIT}`,
        [ctx.orgId, ids],
      );
      return { children, upcoming, history, attendance, packages, invoices };
    });
  });

  // Catatan terapi FINAL satu anak. Dimuat terpisah agar audit hanya mencatat pembacaan yang nyata.
  app.get('/portal/notes', async (req) => {
    const ctx = needPortal(req);
    const { patientId } = parse(z.object({ patientId: z.uuid() }), req.query);
    const notes = await portalTx(app, ctx, async (db) => {
      const linked = await db.maybe(
        `SELECT 1 FROM guardians g WHERE g.organization_id = $1 AND g.patient_id = $2 AND g.member_id = $3 LIMIT 1`,
        [ctx.orgId, patientId, ctx.memberId],
      );
      if (!linked) throw notFound('Anak');
      return db.many(
        `SELECT n.id, n.note_type, n.objectives, n.activities, n.observations, n.home_program, n.next_plan,
                u.full_name AS author_name,
                to_char(coalesce(a.starts_at, n.finalized_at) AT TIME ZONE $3, 'YYYY-MM-DD') AS local_date
           FROM therapy_notes n
           JOIN memberships m ON m.organization_id = n.organization_id AND m.id = n.author_member_id
           JOIN users u ON u.id = m.user_id
           LEFT JOIN appointments a ON a.organization_id = n.organization_id AND a.id = n.appointment_id
          WHERE n.organization_id = $1 AND n.patient_id = $2 AND n.status = 'final'
          ORDER BY coalesce(a.starts_at, n.finalized_at) DESC LIMIT ${NOTE_LIMIT}`,
        [ctx.orgId, patientId, ctx.timezone],
      );
    });
    if (notes.length > 0) {
      await portalAuditTx(app, ctx, (db) =>
        audit(db, req, ctx, { action: 'catatan.dilihat_wali', entityType: 'patient', entityId: patientId, meta: { jumlah: notes.length } }),
      );
    }
    return notes;
  });
}
