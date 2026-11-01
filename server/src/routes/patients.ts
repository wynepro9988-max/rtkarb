import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, changedFields } from '../audit.ts';
import { can, needTenant, tenantTx } from '../authz/context.ts';
import { dataScopes } from '../authz/permissions.ts';
import type { Db } from '../db.ts';
import { badRequest, notFound } from '../errors.ts';
import { idParam, likePattern, parse, zDate, zOptText, zPaging, zText } from '../http.ts';
import { nextCounter } from '../lib/counters.ts';
import { closeGuardianAccountIfUnlinked, GUARDIAN_ACCOUNT_FIELDS } from './guardian-accounts.ts';

const guardianBody = z.object({
  fullName: zText(2, 150),
  relationship: zText(2, 40),
  phone: zOptText(40),
  email: zOptText(200),
  address: zOptText(500),
  isPrimary: z.boolean().default(false),
  // Wali menolak pengingat WhatsApp otomatis.
  waOptOut: z.boolean().default(false),
});

const patientBody = z.object({
  fullName: zText(2, 150),
  nickname: zOptText(60),
  birthDate: zDate.nullish(),
  sex: z.enum(['L', 'P']).nullish(),
  registeredOn: zDate.optional(),
  address: zOptText(500),
  adminNotes: zOptText(2000),
  guardians: z.array(guardianBody).max(4).default([]),
});

const patientPatch = z.object({
  fullName: zText(2, 150).optional(),
  nickname: zOptText(60).optional(),
  birthDate: zDate.nullish(),
  sex: z.enum(['L', 'P']).nullish(),
  status: z.enum(['aktif', 'nonaktif', 'selesai']).optional(),
  registeredOn: zDate.optional(),
  address: zOptText(500).optional(),
  adminNotes: zOptText(2000).optional(),
});

const PATIENT_COLUMNS: Record<string, string> = {
  fullName: 'full_name',
  nickname: 'nickname',
  birthDate: 'birth_date',
  sex: 'sex',
  status: 'status',
  registeredOn: 'registered_on',
  address: 'address',
  adminNotes: 'admin_notes',
};
const GUARDIAN_COLUMNS: Record<string, string> = {
  fullName: 'full_name',
  relationship: 'relationship',
  phone: 'phone',
  email: 'email',
  address: 'address',
  isPrimary: 'is_primary',
  waOptOut: 'wa_opt_out',
};

const PATIENT_FIELDS = `p.id, p.patient_code, p.full_name, p.nickname, p.birth_date, p.sex, p.status,
  p.registered_on, p.address, p.admin_notes, p.anonymized_at, p.created_at, p.updated_at`;

async function insertGuardian(db: Db, orgId: string, patientId: string, userId: string, g: z.output<typeof guardianBody>) {
  if (g.isPrimary) {
    await db.exec(`UPDATE guardians SET is_primary = false WHERE organization_id = $1 AND patient_id = $2`, [orgId, patientId]);
  }
  return db.one<{ id: string }>(
    `INSERT INTO guardians (organization_id, patient_id, full_name, relationship, phone, email, address, is_primary, wa_opt_out, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING id`,
    [orgId, patientId, g.fullName, g.relationship, g.phone, g.email, g.address, g.isPrimary, g.waOptOut, userId],
  );
}

export async function requirePatient(db: Db, orgId: string, patientId: string) {
  const p = await db.maybe<{ id: string; status: string; fullName: string; patientCode: string }>(
    `SELECT id, status, full_name, patient_code FROM patients WHERE organization_id = $1 AND id = $2`,
    [orgId, patientId],
  );
  if (!p) throw notFound('Pasien');
  return p;
}

export async function patientRoutes(app: FastifyInstance) {
  const READ = ['patient.read', 'patient.read.assigned'] as const;

  app.get('/patients', async (req) => {
    const ctx = needTenant(req, ...READ);
    const q = parse(
      zPaging.extend({
        q: z.string().trim().max(100).optional(),
        status: z.enum(['aktif', 'nonaktif', 'selesai']).optional(),
      }),
      req.query,
    );
    return tenantTx(app, ctx, async (db) => {
      const rows = await db.many<{ total: number }>(
        `SELECT p.id, p.patient_code, p.full_name, p.nickname, p.birth_date, p.sex, p.status, p.registered_on,
                (SELECT g.full_name FROM guardians g
                  WHERE g.organization_id = p.organization_id AND g.patient_id = p.id
                  ORDER BY g.is_primary DESC, g.created_at LIMIT 1) AS guardian_name,
                count(*) OVER () AS total
           FROM patients p
          WHERE p.organization_id = $1
            AND ($2::text IS NULL OR p.full_name ILIKE $2 OR p.patient_code ILIKE $2 OR p.nickname ILIKE $2)
            AND ($3::text IS NULL OR p.status = $3)
          ORDER BY p.full_name
          LIMIT $4 OFFSET $5`,
        [ctx.orgId, q.q ? likePattern(q.q) : null, q.status ?? null, q.limit, q.offset],
      );
      return { total: rows[0]?.total ?? 0, items: rows.map(({ total: _t, ...r }) => r) };
    });
  });

  app.post('/patients', async (req, reply) => {
    const ctx = needTenant(req, 'patient.manage');
    const body = parse(patientBody, req.body);
    const created = await tenantTx(app, ctx, async (db) => {
      const org = await db.one<{ patientCodePrefix: string }>(`SELECT patient_code_prefix FROM organizations WHERE id = $1`, [ctx.orgId]);
      const seq = await nextCounter(db, ctx.orgId!, 'patient');
      const code = `${org.patientCodePrefix}-${String(seq).padStart(4, '0')}`;
      const p = await db.one<{ id: string; patientCode: string }>(
        `INSERT INTO patients (organization_id, patient_code, full_name, nickname, birth_date, sex, registered_on, address, admin_notes, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, coalesce($7::date, current_date), $8, $9, $10, $10)
         RETURNING id, patient_code`,
        [ctx.orgId, code, body.fullName, body.nickname, body.birthDate ?? null, body.sex ?? null, body.registeredOn ?? null, body.address, body.adminNotes, ctx.userId],
      );
      for (const g of body.guardians) await insertGuardian(db, ctx.orgId!, p.id, ctx.userId, g);
      await audit(db, req, ctx, { action: 'pasien.dibuat', entityType: 'patient', entityId: p.id, meta: { kode: p.patientCode } });
      return p;
    });
    return reply.status(201).send(created);
  });

  app.get('/patients/:id', async (req) => {
    const ctx = needTenant(req, ...READ);
    const id = idParam(req.params);
    return tenantTx(app, ctx, async (db) => {
      const patient = await db.maybe(`SELECT ${PATIENT_FIELDS} FROM patients p WHERE p.organization_id = $1 AND p.id = $2`, [ctx.orgId, id]);
      if (!patient) throw notFound('Pasien');
      const guardians = await db.many(
        `SELECT g.id, g.full_name, g.relationship, g.phone, g.email, g.address, g.is_primary, g.wa_opt_out ${
          can(ctx, 'guardian.invite') ? `, ${GUARDIAN_ACCOUNT_FIELDS}` : ''
        }
           FROM guardians g WHERE g.organization_id = $1 AND g.patient_id = $2 ORDER BY g.is_primary DESC, g.created_at`,
        [ctx.orgId, id],
      );
      const therapists = await db.many(
        `SELECT m.id, u.full_name, m.specialization, m.status
           FROM patient_therapists pt
           JOIN memberships m ON m.organization_id = pt.organization_id AND m.id = pt.member_id
           JOIN users u ON u.id = m.user_id
          WHERE pt.organization_id = $1 AND pt.patient_id = $2 ORDER BY u.full_name`,
        [ctx.orgId, id],
      );
      return { ...patient, guardians, therapists };
    });
  });

  app.patch('/patients/:id', async (req) => {
    const ctx = needTenant(req, 'patient.manage');
    const id = idParam(req.params);
    const patch = parse(patientPatch, req.body);
    return tenantTx(app, ctx, async (db) => {
      const before = await db.maybe<Record<string, unknown>>(
        `SELECT full_name, nickname, birth_date, sex, status, registered_on, address, admin_notes FROM patients WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [ctx.orgId, id],
      );
      if (!before) throw notFound('Pasien');
      const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
      if (keys.length) {
        const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
        const sql = keys.map((k, i) => `${PATIENT_COLUMNS[k]} = $${i + 4}`).join(', ');
        await db.exec(`UPDATE patients SET ${sql}, updated_by = $3 WHERE organization_id = $1 AND id = $2`, [ctx.orgId, id, ctx.userId, ...values]);
        await audit(db, req, ctx, { action: 'pasien.diubah', entityType: 'patient', entityId: id, meta: { field: changedFields(before, patch) } });
      }
      return db.one(`SELECT ${PATIENT_FIELDS} FROM patients p WHERE p.organization_id = $1 AND p.id = $2`, [ctx.orgId, id]);
    });
  });

  // ---- Wali ----
  app.post('/patients/:id/guardians', async (req, reply) => {
    const ctx = needTenant(req, 'patient.manage');
    const id = idParam(req.params);
    const body = parse(guardianBody, req.body);
    const g = await tenantTx(app, ctx, async (db) => {
      await requirePatient(db, ctx.orgId!, id);
      const row = await insertGuardian(db, ctx.orgId!, id, ctx.userId, body);
      await audit(db, req, ctx, { action: 'wali.ditambahkan', entityType: 'patient', entityId: id, meta: { wali_id: row.id } });
      return row;
    });
    return reply.status(201).send(g);
  });

  app.patch('/guardians/:id', async (req) => {
    const ctx = needTenant(req, 'patient.manage');
    const id = idParam(req.params);
    const patch = parse(guardianBody.partial().extend({ isPrimary: z.boolean().optional(), waOptOut: z.boolean().optional() }), req.body);
    return tenantTx(app, ctx, async (db) => {
      const g = await db.maybe<{ patientId: string }>(`SELECT patient_id FROM guardians WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [ctx.orgId, id]);
      if (!g) throw notFound('Wali');
      if (patch.isPrimary) {
        await db.exec(`UPDATE guardians SET is_primary = false WHERE organization_id = $1 AND patient_id = $2`, [ctx.orgId, g.patientId]);
      }
      const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
      if (keys.length) {
        const sql = keys.map((k, i) => `${GUARDIAN_COLUMNS[k]} = $${i + 4}`).join(', ');
        await db.exec(`UPDATE guardians SET ${sql}, updated_by = $3 WHERE organization_id = $1 AND id = $2`, [
          ctx.orgId,
          id,
          ctx.userId,
          ...keys.map((k) => (patch as Record<string, unknown>)[k]),
        ]);
      }
      await audit(db, req, ctx, { action: 'wali.diubah', entityType: 'patient', entityId: g.patientId, meta: { wali_id: id, field: keys } });
      return { ok: true };
    });
  });

  app.delete('/guardians/:id', async (req) => {
    const ctx = needTenant(req, 'patient.manage');
    const id = idParam(req.params);
    await tenantTx(app, ctx, async (db) => {
      const g = await db.maybe<{ patientId: string; memberId: string | null }>(
        `DELETE FROM guardians WHERE organization_id = $1 AND id = $2 RETURNING patient_id, member_id`,
        [ctx.orgId, id],
      );
      if (!g) throw notFound('Wali');
      if (g.memberId) await closeGuardianAccountIfUnlinked(db, ctx.orgId!, g.memberId, ctx.userId);
      await audit(db, req, ctx, { action: 'wali.dihapus', entityType: 'patient', entityId: g.patientId, meta: { wali_id: id } });
    });
    return { ok: true };
  });

  // ---- Penugasan terapis (dasar akses terapis ke pasien) ----
  app.put('/patients/:id/therapists', async (req) => {
    const ctx = needTenant(req, 'patient.assign');
    const id = idParam(req.params);
    const { memberIds } = parse(z.object({ memberIds: z.array(z.uuid()).max(10) }), req.body);
    const unique = [...new Set(memberIds)];
    return tenantTx(app, ctx, async (db) => {
      await requirePatient(db, ctx.orgId!, id);
      if (unique.length) {
        const valid = await db.many<{ id: string }>(
          `SELECT id FROM memberships WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND status = 'active' AND is_therapist`,
          [ctx.orgId, unique],
        );
        if (valid.length !== unique.length) throw badRequest('Terapis yang dipilih tidak valid atau tidak aktif');
      }
      const current = await db.many<{ memberId: string }>(
        `SELECT member_id FROM patient_therapists WHERE organization_id = $1 AND patient_id = $2`,
        [ctx.orgId, id],
      );
      const currentIds = current.map((c) => c.memberId);
      const removed = currentIds.filter((m) => !unique.includes(m));
      const added = unique.filter((m) => !currentIds.includes(m));
      if (removed.length) {
        await db.exec(`DELETE FROM patient_therapists WHERE organization_id = $1 AND patient_id = $2 AND member_id = ANY($3::uuid[])`, [
          ctx.orgId,
          id,
          removed,
        ]);
      }
      for (const m of added) {
        await db.exec(`INSERT INTO patient_therapists (organization_id, patient_id, member_id, created_by) VALUES ($1, $2, $3, $4)`, [
          ctx.orgId,
          id,
          m,
          ctx.userId,
        ]);
      }
      if (added.length || removed.length) {
        await audit(db, req, ctx, { action: 'pasien.penugasan_terapis', entityType: 'patient', entityId: id, meta: { ditambah: added, dilepas: removed } });
      }
      return { memberIds: unique };
    });
  });

  // ---- Ringkasan per pasien ----
  app.get('/patients/:id/appointments', async (req) => {
    const ctx = needTenant(req, 'schedule.read', 'schedule.read.own');
    const id = idParam(req.params);
    return tenantTx(app, ctx, async (db) => {
      await requirePatient(db, ctx.orgId!, id);
      return db.many(
        `SELECT a.id, a.starts_at,
                to_char(a.starts_at AT TIME ZONE $3, 'YYYY-MM-DD') AS local_date,
                to_char(a.starts_at AT TIME ZONE $3, 'HH24:MI') AS local_time,
                a.duration_minutes, a.status, a.billing, a.price, a.cancel_reason,
                u.full_name AS therapist_name, s.name AS service_name,
                n.id AS note_id, n.status AS note_status
           FROM appointments a
           JOIN memberships m ON m.organization_id = a.organization_id AND m.id = a.therapist_member_id
           JOIN users u ON u.id = m.user_id
           LEFT JOIN therapy_services s ON s.organization_id = a.organization_id AND s.id = a.service_id
           LEFT JOIN therapy_notes n ON n.organization_id = a.organization_id AND n.appointment_id = a.id
          WHERE a.organization_id = $1 AND a.patient_id = $2
          ORDER BY a.starts_at DESC LIMIT 200`,
        [ctx.orgId, id, ctx.timezone],
      );
    });
  });

  app.get('/patients/:id/notes', async (req) => {
    const ctx = needTenant(req, 'therapy.note.read', 'therapy.note.read.assigned');
    const id = idParam(req.params);
    return tenantTx(app, ctx, async (db) => {
      await requirePatient(db, ctx.orgId!, id);
      const notes = await db.many(
        `SELECT n.id, n.appointment_id, n.note_type, n.status, n.objectives, n.activities, n.observations,
                n.home_program, n.next_plan, n.revision_no, n.created_at, n.updated_at, n.finalized_at,
                n.author_member_id, u.full_name AS author_name,
                to_char(a.starts_at AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') AS session_at
           FROM therapy_notes n
           JOIN memberships m ON m.organization_id = n.organization_id AND m.id = n.author_member_id
           JOIN users u ON u.id = m.user_id
           LEFT JOIN appointments a ON a.organization_id = n.organization_id AND a.id = n.appointment_id
          WHERE n.organization_id = $1 AND n.patient_id = $2
          ORDER BY coalesce(a.starts_at, n.created_at) DESC LIMIT 200`,
        [ctx.orgId, id, ctx.timezone],
      );
      await audit(db, req, ctx, { action: 'catatan.daftar_dilihat', entityType: 'patient', entityId: id, meta: { jumlah: notes.length } });
      return notes;
    });
  });

  app.get('/patients/:id/packages', async (req) => {
    const ctx = needTenant(req, 'package.read');
    const id = idParam(req.params);
    const withFinance = dataScopes(ctx.permissions).finance === 'all' && can(ctx, 'payment.read');
    return tenantTx(app, ctx, async (db) => {
      await requirePatient(db, ctx.orgId!, id);
      return db.many(
        `SELECT pp.id, pp.name, pp.sessions_total, pp.sessions_used, pp.sessions_total - pp.sessions_used AS sessions_remaining,
                pp.price, pp.purchased_on, pp.expires_on, pp.status, pp.cancel_reason,
                (pp.expires_on IS NOT NULL AND pp.expires_on < (now() AT TIME ZONE $3)::date) AS expired,
                ${withFinance ? `(SELECT coalesce(sum(pay.amount), 0) FROM payments pay
                  WHERE pay.organization_id = pp.organization_id AND pay.patient_package_id = pp.id AND pay.status = 'tercatat')` : 'NULL::bigint'} AS paid_amount
           FROM patient_packages pp
          WHERE pp.organization_id = $1 AND pp.patient_id = $2
          ORDER BY pp.status = 'aktif' DESC, pp.purchased_on DESC`,
        [ctx.orgId, id, ctx.timezone],
      );
    });
  });

  app.get('/patients/:id/payments', async (req) => {
    const ctx = needTenant(req, 'payment.read');
    const id = idParam(req.params);
    return tenantTx(app, ctx, async (db) => {
      await requirePatient(db, ctx.orgId!, id);
      return db.many(
        `SELECT pay.id, pay.receipt_no, pay.paid_on, pay.amount, pay.method, pay.reference, pay.status,
                pay.patient_package_id, pp.name AS package_name, pay.appointment_id, pay.invoice_id
           FROM payments pay
           LEFT JOIN patient_packages pp ON pp.organization_id = pay.organization_id AND pp.id = pay.patient_package_id
          WHERE pay.organization_id = $1 AND pay.patient_id = $2
          ORDER BY pay.paid_on DESC, pay.created_at DESC`,
        [ctx.orgId, id],
      );
    });
  });
}
