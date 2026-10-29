import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { needTenant, tenantTx } from '../authz/context.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { idParam, parse, zOptText } from '../http.ts';
import { requirePatient } from './patients.ts';

const CONTENT_KEYS = ['objectives', 'activities', 'observations', 'homeProgram', 'nextPlan'] as const;

const contentSchema = {
  objectives: zOptText(5000),
  activities: zOptText(5000),
  observations: zOptText(10000),
  homeProgram: zOptText(5000),
  nextPlan: zOptText(5000),
};

const createBody = z.object({
  patientId: z.uuid(),
  appointmentId: z.uuid().nullish(),
  noteType: z.enum(['sesi', 'asesmen', 'evaluasi', 'lainnya']).default('sesi'),
  finalize: z.boolean().default(false),
  ...contentSchema,
});

const updateBody = z.object({
  finalize: z.boolean().default(false),
  reason: zOptText(500),
  objectives: contentSchema.objectives.optional(),
  activities: contentSchema.activities.optional(),
  observations: contentSchema.observations.optional(),
  homeProgram: contentSchema.homeProgram.optional(),
  nextPlan: contentSchema.nextPlan.optional(),
});

const NOTE_SELECT = `
  n.id, n.patient_id, p.full_name AS patient_name, p.patient_code, n.appointment_id, n.note_type, n.status,
  n.objectives, n.activities, n.observations, n.home_program, n.next_plan, n.revision_no,
  n.author_member_id, u.full_name AS author_name, n.created_at, n.updated_at, n.finalized_at,
  to_char(a.starts_at AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') AS session_at`;
const NOTE_FROM = `
  FROM therapy_notes n
  JOIN patients p ON p.organization_id = n.organization_id AND p.id = n.patient_id
  JOIN memberships m ON m.organization_id = n.organization_id AND m.id = n.author_member_id
  JOIN users u ON u.id = m.user_id
  LEFT JOIN appointments a ON a.organization_id = n.organization_id AND a.id = n.appointment_id`;

type Content = Record<(typeof CONTENT_KEYS)[number], string | null>;

function hasContent(c: Partial<Content>) {
  return CONTENT_KEYS.some((k) => c[k]);
}

export async function noteRoutes(app: FastifyInstance) {
  const READ = ['therapy.note.read', 'therapy.note.read.assigned'] as const;

  app.get('/notes/:id', async (req) => {
    const ctx = needTenant(req, ...READ);
    const id = idParam(req.params);
    return tenantTx(app, ctx, async (db) => {
      const note = await db.maybe(`SELECT ${NOTE_SELECT} ${NOTE_FROM} WHERE n.organization_id = $1 AND n.id = $2`, [ctx.orgId, id, ctx.timezone]);
      if (!note) throw notFound('Catatan');
      await audit(db, req, ctx, { action: 'catatan.dilihat', entityType: 'therapy_note', entityId: id });
      return note;
    });
  });

  app.get('/notes/:id/revisions', async (req) => {
    const ctx = needTenant(req, ...READ);
    const id = idParam(req.params);
    return tenantTx(app, ctx, async (db) => {
      const note = await db.maybe<Content & { revisionNo: number; status: string; updatedAt: Date; authorName: string }>(
        `SELECT n.revision_no, n.status, n.objectives, n.activities, n.observations, n.home_program, n.next_plan, n.updated_at,
                u.full_name AS author_name
           FROM therapy_notes n
           JOIN memberships m ON m.organization_id = n.organization_id AND m.id = n.author_member_id
           JOIN users u ON u.id = m.user_id
          WHERE n.organization_id = $1 AND n.id = $2`,
        [ctx.orgId, id],
      );
      if (!note) throw notFound('Catatan');
      // Tabel revisi hanya menyimpan versi yang SUDAH digantikan; `reason` pada baris k adalah
      // alasan versi k digantikan oleh versi k+1 (alasan milik versi k+1).
      const previous = await db.many<{ revisionNo: number; status: string; content: Content; reason: string | null; editedAt: Date; editedByName: string }>(
        `SELECT r.revision_no, r.status, r.content, r.reason, r.edited_at, u.full_name AS edited_by_name
           FROM therapy_note_revisions r
           JOIN memberships m ON m.organization_id = r.organization_id AND m.id = r.edited_by_member_id
           JOIN users u ON u.id = m.user_id
          WHERE r.organization_id = $1 AND r.note_id = $2
          ORDER BY r.revision_no DESC`,
        [ctx.orgId, id],
      );
      const reasonFor = (revisionNo: number) => previous.find((p) => p.revisionNo === revisionNo - 1)?.reason ?? null;
      const current = {
        revisionNo: note.revisionNo,
        status: note.status,
        content: Object.fromEntries(CONTENT_KEYS.map((k) => [k, note[k]])) as Content,
        reason: reasonFor(note.revisionNo),
        editedAt: note.updatedAt,
        editedByName: note.authorName,
      };
      await audit(db, req, ctx, { action: 'catatan.riwayat_dilihat', entityType: 'therapy_note', entityId: id });
      return [current, ...previous.map((p) => ({ ...p, reason: reasonFor(p.revisionNo) }))];
    });
  });

  app.post('/notes', async (req, reply) => {
    const ctx = needTenant(req, 'therapy.note.write');
    if (!ctx.memberId) throw forbidden();
    const body = parse(createBody, req.body);
    if (body.finalize && !hasContent(body)) throw badRequest('Catatan final tidak boleh kosong');

    const created = await tenantTx(app, ctx, async (db) => {
      await requirePatient(db, ctx.orgId!, body.patientId);
      const assigned = await db.maybe(
        `SELECT 1 FROM patient_therapists WHERE organization_id = $1 AND patient_id = $2 AND member_id = $3`,
        [ctx.orgId, body.patientId, ctx.memberId],
      );
      if (!assigned) throw forbidden('Anda belum ditugaskan untuk pasien ini');

      if (body.appointmentId) {
        const a = await db.maybe<{ status: string }>(
          `SELECT status FROM appointments WHERE organization_id = $1 AND id = $2 AND patient_id = $3`,
          [ctx.orgId, body.appointmentId, body.patientId],
        );
        if (!a) throw badRequest('Jadwal tidak ditemukan untuk pasien ini');
        if (a.status === 'dibatalkan' || a.status === 'dijadwal_ulang') throw badRequest('Jadwal ini sudah dibatalkan/dijadwal ulang');
        const exists = await db.maybe(`SELECT 1 FROM therapy_notes WHERE organization_id = $1 AND appointment_id = $2`, [ctx.orgId, body.appointmentId]);
        if (exists) throw conflict('Catatan untuk sesi ini sudah ada');
      }

      const status = body.finalize ? 'final' : 'draf';
      const content: Content = {
        objectives: body.objectives,
        activities: body.activities,
        observations: body.observations,
        homeProgram: body.homeProgram,
        nextPlan: body.nextPlan,
      };
      const note = await db.one<{ id: string }>(
        `INSERT INTO therapy_notes
           (organization_id, patient_id, appointment_id, author_member_id, note_type, status,
            objectives, activities, observations, home_program, next_plan, finalized_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CASE WHEN $6 = 'final' THEN now() END)
         RETURNING id`,
        [
          ctx.orgId,
          body.patientId,
          body.appointmentId ?? null,
          ctx.memberId,
          body.noteType,
          status,
          content.objectives,
          content.activities,
          content.observations,
          content.homeProgram,
          content.nextPlan,
        ],
      );
      await audit(db, req, ctx, {
        action: 'catatan.dibuat',
        entityType: 'therapy_note',
        entityId: note.id,
        meta: { jenis: body.noteType, status, pasien_id: body.patientId },
      });
      return note;
    });
    return reply.status(201).send(created);
  });

  app.put('/notes/:id', async (req) => {
    const ctx = needTenant(req, 'therapy.note.write');
    if (!ctx.memberId) throw forbidden();
    const id = idParam(req.params);
    const body = parse(updateBody, req.body);

    return tenantTx(app, ctx, async (db) => {
      const note = await db.maybe<Content & { authorMemberId: string; status: string; revisionNo: number; updatedAt: Date }>(
        `SELECT author_member_id, status, revision_no, objectives, activities, observations, home_program, next_plan, updated_at
           FROM therapy_notes WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id],
      );
      if (!note) throw notFound('Catatan');
      if (note.authorMemberId !== ctx.memberId) throw forbidden('Hanya penulis catatan yang dapat mengubahnya');

      // FOR UPDATE setelah verifikasi penulis (kebijakan UPDATE hanya untuk penulis).
      await db.exec(`SELECT 1 FROM therapy_notes WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [ctx.orgId, id]);

      const wasFinal = note.status === 'final';
      if (wasFinal && (!body.reason || body.reason.length < 5)) {
        throw badRequest('Catatan final hanya dapat dikoreksi dengan menuliskan alasan (minimal 5 karakter)');
      }
      const next: Content = { ...note };
      const changed: string[] = [];
      for (const k of CONTENT_KEYS) {
        const v = body[k];
        if (v !== undefined && v !== note[k]) {
          next[k] = v;
          changed.push(k);
        }
      }
      const finalizing = !wasFinal && body.finalize;
      if (changed.length === 0 && !finalizing) return { ok: true, revisionNo: note.revisionNo };
      if ((finalizing || wasFinal) && !hasContent(next)) throw badRequest('Catatan final tidak boleh kosong');

      const status = wasFinal || finalizing ? 'final' : 'draf';
      const revision = note.revisionNo + 1;
      const old: Content = Object.fromEntries(CONTENT_KEYS.map((k) => [k, note[k]])) as Content;
      await db.exec(
        `INSERT INTO therapy_note_revisions (organization_id, note_id, revision_no, status, content, reason, edited_by_member_id, edited_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [ctx.orgId, id, note.revisionNo, note.status, JSON.stringify(old), wasFinal ? body.reason : null, ctx.memberId, note.updatedAt],
      );
      await db.exec(
        `UPDATE therapy_notes SET status = $3, objectives = $4, activities = $5, observations = $6, home_program = $7, next_plan = $8,
                revision_no = $9, finalized_at = CASE WHEN $10::boolean THEN now() ELSE finalized_at END
          WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, status, next.objectives, next.activities, next.observations, next.homeProgram, next.nextPlan, revision, finalizing],
      );
      await audit(db, req, ctx, {
        action: wasFinal ? 'catatan.dikoreksi' : finalizing ? 'catatan.difinalkan' : 'catatan.diubah',
        entityType: 'therapy_note',
        entityId: id,
        meta: { revisi: revision, field: changed },
      });
      return { ok: true, revisionNo: revision };
    });
  });
}
