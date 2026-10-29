import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { needTenant, tenantTx, type AuthContext } from '../authz/context.ts';
import type { Db } from '../db.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { idParam, parse, zDate, zOptText, zText } from '../http.ts';
import { requirePatient } from './patients.ts';

// Program terapi: rencana jangka panjang per anak (data klinis; akses = akses catatan terapi).
const READ = ['therapy.note.read', 'therapy.note.read.assigned'] as const;

const goalBody = z.object({ description: zText(2, 1000), successCriteria: zOptText(1000) });

const programBody = z.object({
  title: zText(2, 150),
  serviceId: z.uuid().nullish(),
  summary: zOptText(5000),
  startDate: zDate,
  targetEndDate: zDate.nullish(),
  goals: z.array(goalBody).max(30).default([]),
});

const programPatch = z.object({
  title: zText(2, 150).optional(),
  summary: zOptText(5000).optional(),
  targetEndDate: zDate.nullish(),
  status: z.enum(['aktif', 'selesai', 'dihentikan']).optional(),
  endReason: zOptText(500).optional(),
});

const goalPatch = z.object({
  description: zText(2, 1000).optional(),
  successCriteria: zOptText(1000).optional(),
  status: z.enum(['berjalan', 'tercapai', 'dihentikan']).optional(),
});

// Penulis program/capaian harus ditugaskan ke pasien (sama dengan catatan terapi).
async function requireAssigned(db: Db, ctx: AuthContext, patientId: string) {
  if (!ctx.memberId) throw forbidden();
  const assigned = await db.maybe(`SELECT 1 FROM patient_therapists WHERE organization_id = $1 AND patient_id = $2 AND member_id = $3`, [
    ctx.orgId,
    patientId,
    ctx.memberId,
  ]);
  if (!assigned) throw forbidden('Anda belum ditugaskan untuk pasien ini');
}

export async function programRoutes(app: FastifyInstance) {
  app.get('/patients/:id/programs', async (req) => {
    const ctx = needTenant(req, ...READ);
    const patientId = idParam(req.params);
    return tenantTx(app, ctx, async (db) => {
      await requirePatient(db, ctx.orgId!, patientId);
      const programs = await db.many<{ id: string }>(
        `SELECT pr.id, pr.title, pr.summary, pr.status, pr.start_date, pr.target_end_date, pr.ended_at, pr.end_reason,
                pr.service_id, s.name AS service_name, u.full_name AS created_by_name, pr.created_at, pr.updated_at
           FROM therapy_programs pr
           JOIN memberships m ON m.organization_id = pr.organization_id AND m.id = pr.created_by_member_id
           JOIN users u ON u.id = m.user_id
           LEFT JOIN therapy_services s ON s.organization_id = pr.organization_id AND s.id = pr.service_id
          WHERE pr.organization_id = $1 AND pr.patient_id = $2
          ORDER BY pr.status = 'aktif' DESC, pr.start_date DESC`,
        [ctx.orgId, patientId],
      );
      const goals = await db.many<{ programId: string }>(
        `SELECT g.id, g.program_id, g.description, g.success_criteria, g.status, g.sort_order, g.achieved_at,
                lp.progress_percent AS latest_progress, lp.recorded_at AS latest_recorded_at
           FROM program_goals g
           LEFT JOIN LATERAL (
             SELECT progress_percent, recorded_at FROM goal_progress gp
              WHERE gp.organization_id = g.organization_id AND gp.goal_id = g.id
              ORDER BY gp.recorded_at DESC LIMIT 1) lp ON true
          WHERE g.organization_id = $1 AND g.patient_id = $2
          ORDER BY g.sort_order, g.created_at`,
        [ctx.orgId, patientId],
      );
      await audit(db, req, ctx, { action: 'program.daftar_dilihat', entityType: 'patient', entityId: patientId });
      return programs.map((p) => ({ ...p, goals: goals.filter((g) => g.programId === p.id) }));
    });
  });

  app.post('/patients/:id/programs', async (req, reply) => {
    const ctx = needTenant(req, 'therapy.note.write');
    const patientId = idParam(req.params);
    const body = parse(programBody, req.body);
    if (body.targetEndDate && body.targetEndDate < body.startDate) throw badRequest('Target selesai harus setelah tanggal mulai');
    const created = await tenantTx(app, ctx, async (db) => {
      await requirePatient(db, ctx.orgId!, patientId);
      await requireAssigned(db, ctx, patientId);
      if (body.serviceId) {
        const s = await db.maybe(`SELECT 1 FROM therapy_services WHERE organization_id = $1 AND id = $2`, [ctx.orgId, body.serviceId]);
        if (!s) throw badRequest('Layanan tidak valid');
      }
      const p = await db.one<{ id: string }>(
        `INSERT INTO therapy_programs (organization_id, patient_id, service_id, title, summary, start_date, target_end_date, created_by_member_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [ctx.orgId, patientId, body.serviceId ?? null, body.title, body.summary, body.startDate, body.targetEndDate ?? null, ctx.memberId],
      );
      let order = 0;
      for (const g of body.goals) {
        await db.exec(
          `INSERT INTO program_goals (organization_id, patient_id, program_id, description, success_criteria, sort_order, created_by_member_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [ctx.orgId, patientId, p.id, g.description, g.successCriteria, order++, ctx.memberId],
        );
      }
      await audit(db, req, ctx, { action: 'program.dibuat', entityType: 'therapy_program', entityId: p.id, meta: { pasien_id: patientId, tujuan: body.goals.length } });
      return p;
    });
    return reply.status(201).send(created);
  });

  const loadProgram = async (db: Db, ctx: AuthContext, id: string) => {
    const p = await db.maybe<{ patientId: string; status: string }>(
      `SELECT patient_id, status FROM therapy_programs WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.orgId, id],
    );
    if (!p) throw notFound('Program');
    return p;
  };

  app.patch('/programs/:id', async (req) => {
    const ctx = needTenant(req, 'therapy.note.write');
    const id = idParam(req.params);
    const patch = parse(programPatch, req.body);
    return tenantTx(app, ctx, async (db) => {
      const p = await loadProgram(db, ctx, id);
      await requireAssigned(db, ctx, p.patientId);
      const ending = patch.status && patch.status !== 'aktif' && p.status === 'aktif';
      if (ending && !patch.endReason) throw badRequest('Tuliskan alasan/ringkasan penutupan program');
      await db.exec(
        `UPDATE therapy_programs
            SET title = coalesce($3, title),
                summary = CASE WHEN $4::boolean THEN $5 ELSE summary END,
                target_end_date = CASE WHEN $6::boolean THEN $7::date ELSE target_end_date END,
                status = coalesce($8, status),
                end_reason = CASE WHEN $9::boolean THEN $10 ELSE end_reason END,
                ended_at = CASE WHEN $8 IS NULL THEN ended_at WHEN $8 = 'aktif' THEN NULL ELSE coalesce(ended_at, now()) END
          WHERE organization_id = $1 AND id = $2`,
        [
          ctx.orgId,
          id,
          patch.title ?? null,
          patch.summary !== undefined,
          patch.summary ?? null,
          patch.targetEndDate !== undefined,
          patch.targetEndDate ?? null,
          patch.status ?? null,
          patch.endReason !== undefined,
          patch.endReason ?? null,
        ],
      );
      await audit(db, req, ctx, { action: 'program.diubah', entityType: 'therapy_program', entityId: id, meta: { field: Object.keys(patch) } });
      return { ok: true };
    });
  });

  app.post('/programs/:id/goals', async (req, reply) => {
    const ctx = needTenant(req, 'therapy.note.write');
    const id = idParam(req.params);
    const body = parse(goalBody, req.body);
    const g = await tenantTx(app, ctx, async (db) => {
      const p = await loadProgram(db, ctx, id);
      await requireAssigned(db, ctx, p.patientId);
      const row = await db.one<{ id: string }>(
        `INSERT INTO program_goals (organization_id, patient_id, program_id, description, success_criteria, sort_order, created_by_member_id)
         VALUES ($1, $2, $3, $4, $5,
                 (SELECT coalesce(max(sort_order) + 1, 0) FROM program_goals WHERE organization_id = $1 AND program_id = $3), $6)
         RETURNING id`,
        [ctx.orgId, p.patientId, id, body.description, body.successCriteria, ctx.memberId],
      );
      await audit(db, req, ctx, { action: 'program.tujuan_ditambah', entityType: 'therapy_program', entityId: id, meta: { tujuan_id: row.id } });
      return row;
    });
    return reply.status(201).send(g);
  });

  const loadGoal = async (db: Db, ctx: AuthContext, id: string) => {
    const g = await db.maybe<{ patientId: string; programId: string; status: string }>(
      `SELECT patient_id, program_id, status FROM program_goals WHERE organization_id = $1 AND id = $2`,
      [ctx.orgId, id],
    );
    if (!g) throw notFound('Tujuan');
    return g;
  };

  app.patch('/goals/:id', async (req) => {
    const ctx = needTenant(req, 'therapy.note.write');
    const id = idParam(req.params);
    const patch = parse(goalPatch, req.body);
    return tenantTx(app, ctx, async (db) => {
      const g = await loadGoal(db, ctx, id);
      await requireAssigned(db, ctx, g.patientId);
      await db.exec(
        `UPDATE program_goals
            SET description = coalesce($3, description),
                success_criteria = CASE WHEN $4::boolean THEN $5 ELSE success_criteria END,
                status = coalesce($6, status),
                achieved_at = CASE WHEN $6 = 'tercapai' THEN coalesce(achieved_at, now()) WHEN $6 IS NULL THEN achieved_at ELSE NULL END
          WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, patch.description ?? null, patch.successCriteria !== undefined, patch.successCriteria ?? null, patch.status ?? null],
      );
      await audit(db, req, ctx, { action: 'program.tujuan_diubah', entityType: 'program_goal', entityId: id, meta: { field: Object.keys(patch), status: patch.status } });
      return { ok: true };
    });
  });

  app.post('/goals/:id/progress', async (req, reply) => {
    const ctx = needTenant(req, 'therapy.note.write');
    const id = idParam(req.params);
    const body = parse(
      z.object({ progressPercent: z.number().int().min(0).max(100), note: zOptText(2000), appointmentId: z.uuid().nullish() }),
      req.body,
    );
    const row = await tenantTx(app, ctx, async (db) => {
      const g = await loadGoal(db, ctx, id);
      await requireAssigned(db, ctx, g.patientId);
      if (g.status !== 'berjalan') throw badRequest('Tujuan ini sudah tidak berjalan');
      const r = await db.one<{ id: string }>(
        `INSERT INTO goal_progress (organization_id, patient_id, goal_id, appointment_id, progress_percent, note, recorded_by_member_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [ctx.orgId, g.patientId, id, body.appointmentId ?? null, body.progressPercent, body.note, ctx.memberId],
      );
      await audit(db, req, ctx, { action: 'program.capaian_dicatat', entityType: 'program_goal', entityId: id });
      return r;
    });
    return reply.status(201).send(row);
  });

  app.get('/goals/:id/progress', async (req) => {
    const ctx = needTenant(req, ...READ);
    const id = idParam(req.params);
    return tenantTx(app, ctx, async (db) => {
      await loadGoal(db, ctx, id);
      return db.many(
        `SELECT gp.id, gp.progress_percent, gp.note, gp.recorded_at, gp.appointment_id, u.full_name AS recorded_by_name,
                to_char(a.starts_at AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') AS session_at
           FROM goal_progress gp
           JOIN memberships m ON m.organization_id = gp.organization_id AND m.id = gp.recorded_by_member_id
           JOIN users u ON u.id = m.user_id
           LEFT JOIN appointments a ON a.organization_id = gp.organization_id AND a.id = gp.appointment_id
          WHERE gp.organization_id = $1 AND gp.goal_id = $2
          ORDER BY gp.recorded_at DESC LIMIT 200`,
        [ctx.orgId, id, ctx.timezone],
      );
    });
  });
}
