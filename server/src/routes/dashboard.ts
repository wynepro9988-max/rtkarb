import type { FastifyInstance } from 'fastify';
import { can, needTenant, tenantTx } from '../authz/context.ts';
import { dataScopes } from '../authz/permissions.ts';
import { noteDeadlineSql, noteNotFinalSql, noteOverdueSql } from '../lib/note-deadline.ts';
import { APPT_FROM, APPT_SELECT } from './appointments.ts';

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard', async (req) => {
    const ctx = needTenant(req, 'org.read');
    const scopes = dataScopes(ctx.permissions);
    const ownOnly = !can(ctx, 'schedule.read');

    return tenantTx(app, ctx, async (db) => {
      const today = await db.one<{ d: string; monthStart: string }>(
        `SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS d,
                to_char(date_trunc('month', now() AT TIME ZONE $1), 'YYYY-MM-DD') AS month_start`,
        [ctx.timezone],
      );
      const out: Record<string, unknown> = { today: today.d };

      if (can(ctx, 'schedule.read', 'schedule.read.own')) {
        out.todayAppointments = await db.many(
          `SELECT ${APPT_SELECT.replaceAll('$TZ', '$2')} ${APPT_FROM}
            WHERE a.organization_id = $1
              AND a.starts_at >= ($3::date)::timestamp AT TIME ZONE $2
              AND a.starts_at < ($3::date + 1)::timestamp AT TIME ZONE $2
              AND a.status <> 'dijadwal_ulang'
              AND ($4::uuid IS NULL OR a.therapist_member_id = $4)
            ORDER BY a.starts_at`,
          [ctx.orgId, ctx.timezone, today.d, ownOnly ? ctx.memberId : null],
        );
        out.monthSessions = await db.one(
          `SELECT count(*) FILTER (WHERE status = 'selesai') AS completed,
                  count(*) FILTER (WHERE status = 'tidak_hadir') AS no_show,
                  count(*) FILTER (WHERE status = 'terjadwal') AS scheduled
             FROM appointments
            WHERE organization_id = $1 AND starts_at >= ($2::date)::timestamp AT TIME ZONE $3
              AND ($4::uuid IS NULL OR therapist_member_id = $4)`,
          [ctx.orgId, today.monthStart, ctx.timezone, ownOnly ? ctx.memberId : null],
        );
      }

      if (scopes.patient !== 'none') {
        out.activePatients = (
          await db.one<{ count: number }>(`SELECT count(*) AS count FROM patients WHERE organization_id = $1 AND status = 'aktif'`, [ctx.orgId])
        ).count;
      }

      if (scopes.note !== 'none') {
        // Sesi selesai yang belum punya catatan final (untuk terapis: sesi miliknya). Batasnya akhir
        // bulan sesi; yang paling lama (paling mendesak) tampil lebih dulu.
        const pendingWhere = `a.organization_id = $1 AND a.status = 'selesai' AND ${noteNotFinalSql}
              AND ($3::uuid IS NULL OR a.therapist_member_id = $3)`;
        const params = [ctx.orgId, ctx.timezone, ownOnly ? ctx.memberId : null];
        out.pendingNotes = await db.many(
          `SELECT a.id AS appointment_id, a.patient_id, p.full_name AS patient_name, p.patient_code,
                  to_char(a.starts_at AT TIME ZONE $2, 'YYYY-MM-DD HH24:MI') AS session_at, u.full_name AS therapist_name,
                  a.therapist_member_id, n.id AS note_id, n.status AS note_status,
                  ${noteDeadlineSql('$2')} AS deadline, ${noteOverdueSql('$2')} AS overdue
             FROM appointments a
             JOIN patients p ON p.organization_id = a.organization_id AND p.id = a.patient_id
             JOIN memberships m ON m.organization_id = a.organization_id AND m.id = a.therapist_member_id
             JOIN users u ON u.id = m.user_id
             LEFT JOIN therapy_notes n ON n.organization_id = a.organization_id AND n.appointment_id = a.id
            WHERE ${pendingWhere}
            ORDER BY a.starts_at LIMIT 20`,
          params,
        );
        out.notesDue = await db.one(
          `SELECT count(*) AS pending, count(*) FILTER (WHERE ${noteOverdueSql('$2')}) AS overdue,
                  to_char(date_trunc('month', now() AT TIME ZONE $2) + interval '1 month - 1 day', 'YYYY-MM-DD') AS month_deadline
             FROM appointments a
             JOIN patients p ON p.organization_id = a.organization_id AND p.id = a.patient_id
             LEFT JOIN therapy_notes n ON n.organization_id = a.organization_id AND n.appointment_id = a.id
            WHERE ${pendingWhere}`,
          params,
        );
      }

      if (can(ctx, 'package.read')) {
        out.lowPackages = await db.many(
          `SELECT pp.id, pp.patient_id, p.full_name AS patient_name, p.patient_code, pp.name,
                  pp.sessions_total - pp.sessions_used AS sessions_remaining, pp.expires_on
             FROM patient_packages pp JOIN patients p ON p.organization_id = pp.organization_id AND p.id = pp.patient_id
            WHERE pp.organization_id = $1 AND pp.status = 'aktif'
              AND (pp.sessions_total - pp.sessions_used <= 2
                   OR (pp.expires_on IS NOT NULL AND pp.expires_on <= (now() AT TIME ZONE $2)::date + 14))
            ORDER BY pp.sessions_total - pp.sessions_used, pp.expires_on NULLS LAST LIMIT 20`,
          [ctx.orgId, ctx.timezone],
        );
      }

      if (can(ctx, 'payment.read')) {
        out.payments = await db.one(
          `SELECT coalesce(sum(amount) FILTER (WHERE paid_on = $2), 0) AS today,
                  coalesce(sum(amount) FILTER (WHERE paid_on >= $3), 0) AS month,
                  count(*) FILTER (WHERE paid_on >= $3) AS month_count
             FROM payments WHERE organization_id = $1 AND status = 'tercatat' AND paid_on >= $3`,
          [ctx.orgId, today.d, today.monthStart],
        );
      }

      if (can(ctx, 'compensation.read.own') && !can(ctx, 'compensation.read')) {
        out.myCompensation = await db.one(
          `SELECT coalesce(sum(amount) FILTER (WHERE status = 'dihitung'), 0) AS unpaid, count(*) FILTER (WHERE status <> 'dibatalkan') AS sessions
             FROM therapist_compensations WHERE organization_id = $1 AND member_id = $2 AND session_date >= $3`,
          [ctx.orgId, ctx.memberId, today.monthStart],
        );
      }

      if (can(ctx, 'support.approve') && ctx.mode === 'tenant') {
        out.support = await db.one(
          `SELECT count(*) FILTER (WHERE status = 'menunggu') AS pending,
                  count(*) FILTER (WHERE status = 'disetujui' AND revoked_at IS NULL AND now() < expires_at) AS active
             FROM support_access_grants WHERE organization_id = $1`,
          [ctx.orgId],
        );
      }

      if (can(ctx, 'staff.read')) {
        out.activeStaff = (
          await db.one<{ count: number }>(`SELECT count(*) AS count FROM memberships WHERE organization_id = $1 AND status = 'active' AND role <> 'wali'`, [ctx.orgId])
        ).count;
      }
      return out;
    });
  });
}
