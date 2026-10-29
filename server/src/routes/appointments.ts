import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { can, needTenant, tenantTx, type AuthContext } from '../authz/context.ts';
import type { Db } from '../db.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { idParam, parse, zDate, zMoney, zOptText, zText, zTime } from '../http.ts';
import { requirePatient } from './patients.ts';

const createBody = z.object({
  patientId: z.uuid(),
  therapistMemberId: z.uuid(),
  serviceId: z.uuid().nullish(),
  date: zDate,
  time: zTime,
  durationMinutes: z.number().int().min(5).max(480).optional(),
  billing: z.enum(['paket', 'per_sesi', 'tanpa_biaya']),
  patientPackageId: z.uuid().nullish(),
  price: zMoney.optional(),
  adminNotes: zOptText(1000),
  repeatWeeks: z.number().int().min(1).max(12).default(1),
});

const rescheduleBody = z.object({
  date: zDate,
  time: zTime,
  therapistMemberId: z.uuid().optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
});

const reasonBody = z.object({ reason: zText(3, 500) });

export const APPT_SELECT = `
  a.id, a.patient_id, p.full_name AS patient_name, p.patient_code,
  a.therapist_member_id, u.full_name AS therapist_name,
  a.service_id, s.name AS service_name,
  a.starts_at,
  to_char(a.starts_at AT TIME ZONE $TZ, 'YYYY-MM-DD') AS local_date,
  to_char(a.starts_at AT TIME ZONE $TZ, 'HH24:MI') AS local_time,
  a.duration_minutes, a.status, a.billing, a.patient_package_id, pp.name AS package_name,
  a.price, a.cancel_reason, a.admin_notes, a.rescheduled_from_id, a.completed_at,
  n.id AS note_id, n.status AS note_status`;

export const APPT_FROM = `
  FROM appointments a
  LEFT JOIN patients p ON p.organization_id = a.organization_id AND p.id = a.patient_id
  JOIN memberships m ON m.organization_id = a.organization_id AND m.id = a.therapist_member_id
  JOIN users u ON u.id = m.user_id
  LEFT JOIN therapy_services s ON s.organization_id = a.organization_id AND s.id = a.service_id
  LEFT JOIN patient_packages pp ON pp.organization_id = a.organization_id AND pp.id = a.patient_package_id
  LEFT JOIN therapy_notes n ON n.organization_id = a.organization_id AND n.appointment_id = a.id`;

interface ApptRow {
  id: string;
  patientId: string;
  therapistMemberId: string;
  serviceId: string | null;
  status: string;
  billing: string;
  patientPackageId: string | null;
  price: number;
  durationMinutes: number;
  localDate: string;
  startsAt: Date;
}

async function lockAppointment(db: Db, ctx: AuthContext, id: string): Promise<ApptRow> {
  const a = await db.maybe<ApptRow>(
    `SELECT id, patient_id, therapist_member_id, service_id, status, billing, patient_package_id, price, duration_minutes, starts_at,
            to_char(starts_at AT TIME ZONE $3, 'YYYY-MM-DD') AS local_date
       FROM appointments WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
    [ctx.orgId, id, ctx.timezone],
  );
  if (!a) throw notFound('Jadwal');
  return a;
}

function assertCanRecordSession(ctx: AuthContext, a: ApptRow) {
  if (can(ctx, 'session.complete')) return;
  if (can(ctx, 'session.complete.own') && a.therapistMemberId === ctx.memberId) return;
  throw forbidden('Anda hanya dapat mencatat sesi yang Anda tangani');
}

async function requireTherapist(db: Db, orgId: string, memberId: string) {
  const t = await db.maybe(
    `SELECT 1 FROM memberships WHERE organization_id = $1 AND id = $2 AND status = 'active' AND is_therapist`,
    [orgId, memberId],
  );
  if (!t) throw badRequest('Terapis tidak valid atau tidak aktif');
}

// Mencegah jadwal bentrok untuk terapis maupun pasien.
async function assertNoOverlap(
  db: Db,
  orgId: string,
  therapistId: string,
  patientId: string,
  startsAt: string,
  minutes: number,
  excludeId: string | null,
) {
  await db.exec(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`therapist:${therapistId}`]);
  const clash = await db.maybe<{ who: string }>(
    `SELECT CASE WHEN therapist_member_id = $2 THEN 'terapis' ELSE 'pasien' END AS who
       FROM appointments
      WHERE organization_id = $1 AND status = 'terjadwal'
        AND (therapist_member_id = $2 OR patient_id = $3)
        AND ($6::uuid IS NULL OR id <> $6)
        AND tstzrange(starts_at, starts_at + make_interval(mins => duration_minutes))
            && tstzrange($4::timestamptz, $4::timestamptz + make_interval(mins => $5))
      LIMIT 1`,
    [orgId, therapistId, patientId, startsAt, minutes, excludeId],
  );
  if (clash) {
    throw conflict(
      clash.who === 'terapis'
        ? 'Terapis sudah memiliki jadwal lain pada waktu tersebut'
        : 'Pasien sudah memiliki jadwal lain pada waktu tersebut',
    );
  }
}

async function toTimestamp(db: Db, date: string, time: string, tz: string): Promise<string> {
  const r = await db.one<{ ts: Date }>(`SELECT (($1::date + $2::time)::timestamp AT TIME ZONE $3) AS ts`, [date, time, tz]);
  return r.ts.toISOString();
}

export async function appointmentRoutes(app: FastifyInstance) {
  app.get('/appointments', async (req) => {
    const ctx = needTenant(req, 'schedule.read', 'schedule.read.own');
    const q = parse(
      z
        .object({
          from: zDate,
          to: zDate,
          therapistId: z.uuid().optional(),
          patientId: z.uuid().optional(),
          status: z.enum(['terjadwal', 'selesai', 'tidak_hadir', 'dibatalkan', 'dijadwal_ulang']).optional(),
        })
        .refine((r) => r.from <= r.to && (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 <= 62, 'Rentang maksimal 62 hari'),
      req.query,
    );
    // Terapis hanya melihat jadwal yang ia tangani.
    const ownOnly = !can(ctx, 'schedule.read');
    return tenantTx(app, ctx, (db) =>
      db.many(
        `SELECT ${APPT_SELECT.replaceAll('$TZ', '$2')} ${APPT_FROM}
          WHERE a.organization_id = $1
            AND a.starts_at >= ($3::date)::timestamp AT TIME ZONE $2
            AND a.starts_at < ($4::date + 1)::timestamp AT TIME ZONE $2
            AND ($5::uuid IS NULL OR a.therapist_member_id = $5)
            AND ($6::uuid IS NULL OR a.patient_id = $6)
            AND ($7::text IS NULL OR a.status = $7)
          ORDER BY a.starts_at, u.full_name`,
        [ctx.orgId, ctx.timezone, q.from, q.to, ownOnly ? ctx.memberId : (q.therapistId ?? null), q.patientId ?? null, q.status ?? null],
      ),
    );
  });

  app.get('/appointments/:id', async (req) => {
    const ctx = needTenant(req, 'schedule.read', 'schedule.read.own');
    const id = idParam(req.params);
    return tenantTx(app, ctx, async (db) => {
      const a = await db.maybe(`SELECT ${APPT_SELECT.replaceAll('$TZ', '$3')} ${APPT_FROM} WHERE a.organization_id = $1 AND a.id = $2`, [
        ctx.orgId,
        id,
        ctx.timezone,
      ]);
      if (!a) throw notFound('Jadwal');
      const history = can(ctx, 'audit.read')
        ? await db.many(
            `SELECT l.action, l.meta, l.created_at, coalesce(u.full_name, g.requested_by_name) AS actor_name
               FROM audit_logs l
               LEFT JOIN users u ON u.id = l.actor_user_id
               LEFT JOIN support_access_grants g ON g.id = l.support_grant_id
              WHERE l.organization_id = $1 AND l.entity_type = 'appointment' AND l.entity_id = $2
              ORDER BY l.created_at`,
            [ctx.orgId, id],
          )
        : null;
      return { ...a, history };
    });
  });

  app.post('/appointments', async (req, reply) => {
    const ctx = needTenant(req, 'schedule.manage');
    const body = parse(createBody, req.body);
    const created = await tenantTx(app, ctx, async (db) => {
      const patient = await requirePatient(db, ctx.orgId!, body.patientId);
      if (patient.status !== 'aktif') throw badRequest('Pasien tidak berstatus aktif');
      await requireTherapist(db, ctx.orgId!, body.therapistMemberId);

      let duration = body.durationMinutes;
      let price = 0;
      let serviceId = body.serviceId ?? null;
      let packageId: string | null = null;

      if (serviceId) {
        const s = await db.maybe<{ defaultDurationMinutes: number; defaultPrice: number }>(
          `SELECT default_duration_minutes, default_price FROM therapy_services WHERE organization_id = $1 AND id = $2 AND active`,
          [ctx.orgId, serviceId],
        );
        if (!s) throw badRequest('Layanan tidak valid atau tidak aktif');
        duration ??= s.defaultDurationMinutes;
        if (body.billing === 'per_sesi') price = body.price ?? s.defaultPrice;
      } else if (body.billing === 'per_sesi') {
        price = body.price ?? 0;
      }

      if (body.billing === 'paket') {
        if (!body.patientPackageId) throw badRequest('Pilih paket untuk jadwal dengan tagihan paket');
        const pkg = await db.maybe<{ id: string; serviceId: string | null; status: string; expiresOn: string | null }>(
          `SELECT id, service_id, status, expires_on FROM patient_packages
            WHERE organization_id = $1 AND id = $2 AND patient_id = $3`,
          [ctx.orgId, body.patientPackageId, body.patientId],
        );
        if (!pkg) throw badRequest('Paket tidak ditemukan untuk pasien ini');
        if (pkg.status !== 'aktif') throw badRequest('Paket tidak aktif');
        if (pkg.expiresOn && pkg.expiresOn < body.date) throw badRequest('Paket sudah kedaluwarsa pada tanggal jadwal');
        packageId = pkg.id;
        serviceId ??= pkg.serviceId;
      }
      duration ??= 60;

      const ids: string[] = [];
      for (let week = 0; week < body.repeatWeeks; week++) {
        const date = new Date(Date.parse(`${body.date}T00:00:00Z`) + week * 7 * 86_400_000).toISOString().slice(0, 10);
        const startsAt = await toTimestamp(db, date, body.time, ctx.timezone);
        await assertNoOverlap(db, ctx.orgId!, body.therapistMemberId, body.patientId, startsAt, duration, null);
        const row = await db.one<{ id: string }>(
          `INSERT INTO appointments
             (organization_id, patient_id, therapist_member_id, service_id, starts_at, duration_minutes, billing, patient_package_id, price, admin_notes, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) RETURNING id`,
          [ctx.orgId, body.patientId, body.therapistMemberId, serviceId, startsAt, duration, body.billing, packageId, price, body.adminNotes, ctx.userId],
        );
        ids.push(row.id);
        await audit(db, req, ctx, { action: 'jadwal.dibuat', entityType: 'appointment', entityId: row.id });
      }

      // Terapis yang dijadwalkan otomatis ditugaskan ke pasien agar dapat menulis catatan.
      await db.exec(
        `INSERT INTO patient_therapists (organization_id, patient_id, member_id, created_by)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [ctx.orgId, body.patientId, body.therapistMemberId, ctx.userId],
      );
      return ids;
    });
    return reply.status(201).send({ ids: created });
  });

  app.post('/appointments/:id/reschedule', async (req) => {
    const ctx = needTenant(req, 'schedule.manage');
    const id = idParam(req.params);
    const body = parse(rescheduleBody, req.body);
    return tenantTx(app, ctx, async (db) => {
      const a = await lockAppointment(db, ctx, id);
      if (a.status !== 'terjadwal') throw conflict('Hanya jadwal berstatus terjadwal yang dapat dijadwalkan ulang');
      const therapist = body.therapistMemberId ?? a.therapistMemberId;
      if (body.therapistMemberId) await requireTherapist(db, ctx.orgId!, therapist);
      const duration = body.durationMinutes ?? a.durationMinutes;
      const startsAt = await toTimestamp(db, body.date, body.time, ctx.timezone);
      await assertNoOverlap(db, ctx.orgId!, therapist, a.patientId, startsAt, duration, a.id);

      await db.exec(`UPDATE appointments SET status = 'dijadwal_ulang', updated_by = $3 WHERE organization_id = $1 AND id = $2`, [ctx.orgId, id, ctx.userId]);
      const row = await db.one<{ id: string }>(
        `INSERT INTO appointments
           (organization_id, patient_id, therapist_member_id, service_id, starts_at, duration_minutes, billing, patient_package_id, price,
            rescheduled_from_id, admin_notes, created_by, updated_by)
         SELECT organization_id, patient_id, $3, service_id, $4, $5, billing, patient_package_id, price, id, admin_notes, $6, $6
           FROM appointments WHERE organization_id = $1 AND id = $2
         RETURNING id`,
        [ctx.orgId, id, therapist, startsAt, duration, ctx.userId],
      );
      await db.exec(
        `INSERT INTO patient_therapists (organization_id, patient_id, member_id, created_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [ctx.orgId, a.patientId, therapist, ctx.userId],
      );
      await audit(db, req, ctx, { action: 'jadwal.dijadwal_ulang', entityType: 'appointment', entityId: id, meta: { jadwal_baru: row.id } });
      await audit(db, req, ctx, { action: 'jadwal.dibuat', entityType: 'appointment', entityId: row.id, meta: { dari: id } });
      return { id: row.id };
    });
  });

  app.post('/appointments/:id/cancel', async (req) => {
    const ctx = needTenant(req, 'schedule.manage');
    const id = idParam(req.params);
    const { reason } = parse(reasonBody, req.body);
    await tenantTx(app, ctx, async (db) => {
      const a = await lockAppointment(db, ctx, id);
      if (a.status !== 'terjadwal') throw conflict('Hanya jadwal berstatus terjadwal yang dapat dibatalkan');
      await db.exec(
        `UPDATE appointments SET status = 'dibatalkan', cancel_reason = $3, updated_by = $4 WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, reason, ctx.userId],
      );
      await audit(db, req, ctx, { action: 'jadwal.dibatalkan', entityType: 'appointment', entityId: id });
    });
    return { ok: true };
  });

  // Menyelesaikan sesi: status, pemakaian paket, dan kompensasi dalam satu transaksi.
  app.post('/appointments/:id/complete', async (req) => {
    const ctx = needTenant(req, 'session.complete', 'session.complete.own');
    const id = idParam(req.params);
    return tenantTx(app, ctx, async (db) => {
      const a = await lockAppointment(db, ctx, id);
      assertCanRecordSession(ctx, a);
      if (a.status !== 'terjadwal') throw conflict('Sesi ini sudah tidak berstatus terjadwal');
      const today = await db.one<{ d: string }>(`SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS d`, [ctx.timezone]);
      if (a.localDate > today.d) throw badRequest('Sesi yang dijadwalkan untuk hari mendatang belum dapat diselesaikan');

      let sessionsRemaining: number | null = null;
      if (a.billing === 'paket') {
        // Kunci baris paket + syarat saldo: aman terhadap permintaan bersamaan.
        const pkg = await db.maybe<{ sessionsUsed: number; sessionsTotal: number }>(
          `UPDATE patient_packages
              SET sessions_used = sessions_used + 1,
                  status = CASE WHEN sessions_used + 1 = sessions_total THEN 'selesai' ELSE status END,
                  updated_by = $4
            WHERE organization_id = $1 AND id = $2 AND status = 'aktif'
              AND sessions_used < sessions_total
              AND (expires_on IS NULL OR expires_on >= $3::date)
            RETURNING sessions_used, sessions_total`,
          [ctx.orgId, a.patientPackageId, a.localDate, ctx.userId],
        );
        if (!pkg) throw conflict('Sisa sesi paket tidak mencukupi, paket tidak aktif, atau paket sudah kedaluwarsa');
        await db.exec(
          `INSERT INTO package_ledger (organization_id, patient_id, patient_package_id, appointment_id, kind, sessions_delta, sessions_used_after, created_by)
           VALUES ($1, $2, $3, $4, 'pemakaian', 1, $5, $6)`,
          [ctx.orgId, a.patientId, a.patientPackageId, a.id, pkg.sessionsUsed, ctx.userId],
        );
        sessionsRemaining = pkg.sessionsTotal - pkg.sessionsUsed;
      }

      await db.exec(
        `UPDATE appointments SET status = 'selesai', completed_at = now(), completed_by = $3, updated_by = $3
          WHERE organization_id = $1 AND id = $2 AND status = 'terjadwal'`,
        [ctx.orgId, id, ctx.userId],
      );
      const comp = await db.one<{ amount: number | null }>(`SELECT compute_compensation($1) AS amount`, [id]);
      await audit(db, req, ctx, {
        action: 'sesi.selesai',
        entityType: 'appointment',
        entityId: id,
        meta: { tagihan: a.billing, kompensasi_dihitung: comp.amount !== null },
      });
      return { ok: true, sessionsRemaining };
    });
  });

  app.post('/appointments/:id/no-show', async (req) => {
    const ctx = needTenant(req, 'session.complete', 'session.complete.own');
    const id = idParam(req.params);
    await tenantTx(app, ctx, async (db) => {
      const a = await lockAppointment(db, ctx, id);
      assertCanRecordSession(ctx, a);
      if (a.status !== 'terjadwal') throw conflict('Sesi ini sudah tidak berstatus terjadwal');
      // Kebijakan default: ketidakhadiran TIDAK memotong saldo paket (lihat docs keputusan terbuka).
      await db.exec(
        `UPDATE appointments SET status = 'tidak_hadir', completed_at = now(), completed_by = $3, updated_by = $3
          WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, ctx.userId],
      );
      await audit(db, req, ctx, { action: 'sesi.tidak_hadir', entityType: 'appointment', entityId: id });
    });
    return { ok: true };
  });

  // Koreksi: mengembalikan sesi selesai/tidak hadir ke status terjadwal.
  app.post('/appointments/:id/reopen', async (req) => {
    const ctx = needTenant(req, 'session.reopen');
    const id = idParam(req.params);
    const { reason } = parse(reasonBody, req.body);
    await tenantTx(app, ctx, async (db) => {
      const a = await lockAppointment(db, ctx, id);
      if (a.status !== 'selesai' && a.status !== 'tidak_hadir') throw conflict('Hanya sesi selesai atau tidak hadir yang dapat dikoreksi');

      const paid = await db.maybe(
        `SELECT 1 FROM therapist_compensations WHERE organization_id = $1 AND appointment_id = $2 AND status = 'dibayar'`,
        [ctx.orgId, id],
      );
      if (paid) throw conflict('Honor untuk sesi ini sudah ditandai dibayar. Koreksi honor perlu ditangani terlebih dahulu.');

      if (a.status === 'selesai' && a.billing === 'paket') {
        const pkg = await db.maybe<{ sessionsUsed: number }>(
          `UPDATE patient_packages
              SET sessions_used = sessions_used - 1,
                  status = CASE WHEN status = 'selesai' THEN 'aktif' ELSE status END,
                  updated_by = $3
            WHERE organization_id = $1 AND id = $2 AND sessions_used > 0 AND status <> 'dibatalkan'
            RETURNING sessions_used`,
          [ctx.orgId, a.patientPackageId, ctx.userId],
        );
        if (!pkg) throw conflict('Saldo paket tidak dapat dikembalikan (paket dibatalkan atau saldo tidak sesuai)');
        await db.exec(
          `INSERT INTO package_ledger (organization_id, patient_id, patient_package_id, appointment_id, kind, sessions_delta, sessions_used_after, reason, created_by)
           VALUES ($1, $2, $3, $4, 'pembatalan_pemakaian', -1, $5, $6, $7)`,
          [ctx.orgId, a.patientId, a.patientPackageId, a.id, pkg.sessionsUsed, reason, ctx.userId],
        );
      }
      await db.exec(
        `UPDATE therapist_compensations SET status = 'dibatalkan', cancel_reason = $3, updated_by = $4
          WHERE organization_id = $1 AND appointment_id = $2 AND status = 'dihitung'`,
        [ctx.orgId, id, reason, ctx.userId],
      );
      await db.exec(
        `UPDATE appointments SET status = 'terjadwal', completed_at = NULL, completed_by = NULL, updated_by = $3
          WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id, ctx.userId],
      );
      await audit(db, req, ctx, { action: 'sesi.dikoreksi', entityType: 'appointment', entityId: id, meta: { status_sebelum: a.status } });
    });
    return { ok: true };
  });
}
