import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { needTenant, tenantTx } from '../authz/context.ts';
import type { Db } from '../db.ts';
import { notFound } from '../errors.ts';
import { parse, zDate } from '../http.ts';

// Pengingat jadwal ke wali lewat WhatsApp. Dua cara:
// - "klik untuk kirim" (wa.me): petugas mengirim dari WhatsApp-nya sendiri;
// - otomatis lewat Fonnte (lihat routes/whatsapp.ts), N menit sebelum jadwal sesuai kebijakan organisasi.
// Isi pesan minimal: tanpa jenis layanan/terapi (informasi klinis).
export const DEFAULT_REMINDER_TEMPLATE =
  'Halo {wali}, kami mengingatkan jadwal {anak} di {organisasi} pada {hari}, {tanggal} pukul {jam}. Mohon balas pesan ini untuk konfirmasi kehadiran. Terima kasih.';

// Percobaan maksimal pengiriman otomatis yang gagal untuk satu jadwal.
export const AUTO_MAX_ATTEMPTS = 5;
// Pengingat otomatis tidak dikirim bila jadwal dimulai kurang dari sekian menit lagi.
const AUTO_MIN_MINUTES_BEFORE = 15;

// 08xx / +62 8xx / 62 8xx -> 628xx (format wa.me). Nomor tidak valid -> null.
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('0')) d = `62${d.slice(1)}`;
  else if (d.startsWith('8')) d = `62${d}`;
  return /^62\d{8,13}$/.test(d) ? d : null;
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

// Satu pengingat = satu anak pada satu tanggal (keputusan owner 29 Okt 2026): semua sesinya hari itu
// digabung dalam satu pesan, dikirim N menit sebelum sesi pertama yang belum diingatkan.
export interface ReminderSession {
  appointmentId: string;
  startsAt: Date;
  localTime: string;
  therapistName: string;
  // Pengiriman manual (wa.me).
  sentAt: Date | null;
  auto: { status: string; at: Date; reason: string | null; attempts: number } | null;
}

export interface ReminderGroup {
  patientId: string;
  patientName: string;
  localDate: string;
  guardianName: string | null;
  phone: string | null;
  phoneInvalid: boolean;
  // Wali menolak pengingat otomatis (pengiriman manual tetap dapat dilakukan).
  optOut: boolean;
  sessions: ReminderSession[];
  message: string;
  waUrl: string | null;
}

export function autoEligible(g: ReminderGroup, s: ReminderSession): boolean {
  if (!g.phone || g.optOut || s.sentAt) return false;
  return !s.auto || (s.auto.status === 'gagal' && s.auto.attempts < AUTO_MAX_ATTEMPTS);
}

// "a", "a dan b", "a, b, dan c".
export function joinList(items: string[]): string {
  if (items.length <= 2) return items.join(' dan ');
  return `${items.slice(0, -1).join(', ')}, dan ${items.at(-1)}`;
}

// Semua jadwal pada satu tanggal lokal (`upcomingOnly`: yang belum dimulai), atau pengingat otomatis
// yang jatuh tempo: anak yang punya sesi belum diingatkan dalam `dueWithinMinutes` menit ke depan,
// beserta sesi-sesinya yang lain pada hari yang sama.
export type ReminderFilter = { date: string; upcomingOnly?: boolean } | { dueWithinMinutes: number };

const DAYS = ['', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
const localDay = (alias: string) => `(${alias}.starts_at AT TIME ZONE $2)::date`;

export async function loadReminders(db: Db, orgId: string, timezone: string, filter: ReminderFilter): Promise<ReminderGroup[]> {
  const org = await db.one<{ name: string; reminderTemplate: string | null }>(`SELECT name, reminder_template FROM organizations WHERE id = $1`, [orgId]);
  const template = org.reminderTemplate || DEFAULT_REMINDER_TEMPLATE;
  const soon = `now() + make_interval(mins => ${AUTO_MIN_MINUTES_BEFORE})`;
  const where =
    'date' in filter
      ? `a.starts_at >= ($3::date)::timestamp AT TIME ZONE $2 AND a.starts_at < ($3::date + 1)::timestamp AT TIME ZONE $2${filter.upcomingOnly ? ' AND a.starts_at > now()' : ''}`
      : `a.starts_at > ${soon}
         AND (a.patient_id, ${localDay('a')}) IN (
           SELECT d.patient_id, ${localDay('d')} FROM appointments d
            WHERE d.organization_id = $1 AND d.status = 'terjadwal'
              AND d.starts_at > ${soon} AND d.starts_at <= now() + make_interval(mins => $3::int)
              AND NOT EXISTS (
                SELECT 1 FROM notification_log l
                 WHERE l.organization_id = d.organization_id AND l.appointment_id = d.id
                   AND (l.channel = 'whatsapp' OR (l.channel = 'whatsapp_otomatis'
                        AND NOT (l.status = 'gagal' AND l.attempts < ${AUTO_MAX_ATTEMPTS})))))`;
  const rows = await db.many<{
    appointmentId: string;
    patientId: string;
    startsAt: Date;
    nickname: string | null;
    fullName: string;
    localDate: string;
    localTime: string;
    dayNo: number;
    guardianName: string | null;
    phone: string | null;
    optOut: boolean;
    therapistName: string;
    manualSentAt: Date | null;
    autoStatus: string | null;
    autoAt: Date | null;
    autoReason: string | null;
    autoAttempts: number | null;
  }>(
    `SELECT a.id AS appointment_id, a.patient_id, a.starts_at, p.nickname, p.full_name,
            to_char(a.starts_at AT TIME ZONE $2, 'YYYY-MM-DD') AS local_date,
            to_char(a.starts_at AT TIME ZONE $2, 'HH24:MI') AS local_time,
            extract(isodow FROM (a.starts_at AT TIME ZONE $2))::int AS day_no,
            g.full_name AS guardian_name, g.phone, coalesce(g.wa_opt_out, false) AS opt_out,
            u.full_name AS therapist_name, nm.sent_at AS manual_sent_at,
            na.status AS auto_status, na.sent_at AS auto_at, na.failure_reason AS auto_reason, na.attempts AS auto_attempts
       FROM appointments a
       JOIN patients p ON p.organization_id = a.organization_id AND p.id = a.patient_id
       JOIN memberships m ON m.organization_id = a.organization_id AND m.id = a.therapist_member_id
       JOIN users u ON u.id = m.user_id
       LEFT JOIN LATERAL (
         SELECT full_name, phone, wa_opt_out FROM guardians gg
          WHERE gg.organization_id = a.organization_id AND gg.patient_id = a.patient_id
          ORDER BY gg.is_primary DESC, gg.created_at LIMIT 1) g ON true
       LEFT JOIN notification_log nm ON nm.organization_id = a.organization_id AND nm.appointment_id = a.id AND nm.channel = 'whatsapp'
       LEFT JOIN notification_log na ON na.organization_id = a.organization_id AND na.appointment_id = a.id AND na.channel = 'whatsapp_otomatis'
      WHERE a.organization_id = $1 AND a.status = 'terjadwal' AND ${where}
      ORDER BY a.starts_at`,
    [orgId, timezone, 'date' in filter ? filter.date : filter.dueWithinMinutes],
  );

  const fmtDate = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const groups = new Map<string, { first: (typeof rows)[number]; sessions: ReminderSession[] }>();
  for (const r of rows) {
    const key = `${r.patientId}:${r.localDate}`;
    const g = groups.get(key) ?? { first: r, sessions: [] };
    g.sessions.push({
      appointmentId: r.appointmentId,
      startsAt: r.startsAt,
      localTime: r.localTime,
      therapistName: r.therapistName,
      sentAt: r.manualSentAt,
      auto: r.autoStatus ? { status: r.autoStatus, at: r.autoAt!, reason: r.autoReason, attempts: r.autoAttempts ?? 1 } : null,
    });
    groups.set(key, g);
  }
  // Urutan grup mengikuti sesi pertama masing-masing (baris sudah terurut menurut waktu).
  return [...groups.values()].map(({ first: r, sessions }) => {
    const phone = normalizePhone(r.phone);
    const message = renderTemplate(template, {
      wali: r.guardianName ? `Bapak/Ibu ${r.guardianName}` : 'Bapak/Ibu',
      anak: r.nickname || r.fullName.split(' ')[0],
      organisasi: org.name,
      hari: DAYS[Number(r.dayNo)] ?? '',
      tanggal: fmtDate.format(new Date(`${r.localDate}T00:00:00Z`)),
      jam: joinList(sessions.map((s) => s.localTime)),
      terapis: joinList([...new Set(sessions.map((s) => s.therapistName))]),
    });
    return {
      patientId: r.patientId,
      patientName: r.fullName,
      localDate: r.localDate,
      guardianName: r.guardianName,
      phone,
      phoneInvalid: Boolean(r.phone) && !phone,
      optOut: r.optOut,
      sessions,
      message,
      waUrl: phone ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}` : null,
    };
  });
}

export async function reminderRoutes(app: FastifyInstance) {
  app.get('/reminders', async (req) => {
    const ctx = needTenant(req, 'reminder.send');
    const { date } = parse(z.object({ date: zDate }), req.query);
    return tenantTx(app, ctx, async (db) => {
      const items = await loadReminders(db, ctx.orgId!, ctx.timezone, { date });
      const wa = await db.maybe<{ autoEnabled: boolean; leadMinutes: number }>(
        `SELECT auto_enabled, lead_minutes FROM org_whatsapp WHERE organization_id = $1`,
        [ctx.orgId],
      );
      const autoOn = Boolean(wa?.autoEnabled && app.config.whatsapp.encryptionKey);
      return {
        date,
        whatsapp: { configured: Boolean(wa), autoEnabled: autoOn, leadMinutes: wa?.leadMinutes ?? null },
        items: items.map((g) => {
          // Perkiraan waktu kirim otomatis: N menit sebelum sesi pertama yang belum diingatkan
          // (tepatnya pada putaran cron berikutnya setelah waktu ini).
          const next = g.sessions.find((x) => !x.sentAt && !x.auto);
          return { ...g, autoDueAt: autoOn && !g.optOut && g.phone && next ? new Date(next.startsAt.getTime() - wa!.leadMinutes * 60_000) : null };
        }),
      };
    });
  });

  // Dicatat saat petugas membuka tautan WhatsApp untuk satu anak: semua sesinya pada pesan itu
  // ditandai terkirim (sekali per jadwal per kanal).
  app.post('/reminders/sent', async (req) => {
    const ctx = needTenant(req, 'reminder.send');
    const { appointmentIds } = parse(z.object({ appointmentIds: z.array(z.uuid()).min(1).max(20) }), req.body);
    await tenantTx(app, ctx, async (db) => {
      const appts = await db.many<{ id: string; patientId: string }>(
        `SELECT id, patient_id FROM appointments WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
        [ctx.orgId, appointmentIds],
      );
      if (appts.length !== new Set(appointmentIds).size) throw notFound('Jadwal');
      let logged = 0;
      for (const a of appts) {
        logged += await db.exec(
          `INSERT INTO notification_log (organization_id, patient_id, appointment_id, channel, sent_by)
           VALUES ($1, $2, $3, 'whatsapp', $4) ON CONFLICT (organization_id, appointment_id, channel) DO NOTHING`,
          [ctx.orgId, a.patientId, a.id, ctx.userId],
        );
      }
      if (logged > 0) {
        await audit(db, req, ctx, { action: 'pengingat.dikirim', entityType: 'patient', entityId: appts[0].patientId, meta: { kanal: 'whatsapp', jadwal: logged } });
      }
    });
    return { ok: true };
  });
}
