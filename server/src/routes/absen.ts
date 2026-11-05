import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { can, needTenant, tenantTx, type AuthContext } from '../authz/context.ts';
import type { Db } from '../db.ts';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../errors.ts';
import { idParam, likePattern, parse, zDate, zOptText, zTime } from '../http.ts';
import { mp4Duration, sniffMedia } from '../lib/media.ts';
import { completeAppointment, linkTherapist, lockAppointment, requireTherapist, setTherapist, toTimestamp, type ApptRow } from './appointments.ts';
import { requirePatient } from './patients.ts';

// Absen sesi (keputusan owner 5 Nov 2026): jadwal tidak harus memiliki terapis. Terapis yang
// menangani mencatat sendiri sesi hari itu (pilih pasien lewat No. RM/nama dan layanan, tulis
// aktivitas dan PR); admin/owner dapat mengabsenkan dengan memilih terapisnya. Sesi langsung
// selesai: paket layanan itu terpotong (atau tercatat per sesi) dan honor terhitung.

const absenBody = z.object({
  appointmentId: z.uuid().optional(),
  patientId: z.uuid(),
  serviceId: z.uuid().nullish(),
  therapistMemberId: z.uuid().optional(),
  date: zDate.optional(),
  time: zTime.optional(),
  activities: zOptText(5000),
  homeProgram: zOptText(5000),
});

const MAX_MEDIA_PER_SESSION = 10;
const MIN_VIDEO_SECONDS = 30;
// Absen mundur paling lama sekian hari (mencegah salah ketik tanggal).
const MAX_BACKDATE_DAYS = 31;

async function patientCard(db: Db, ctx: AuthContext, patientId: string) {
  if (can(ctx, 'patient.read')) {
    const p = await requirePatient(db, ctx.orgId!, patientId);
    if (p.status !== 'aktif') throw badRequest('Pasien tidak berstatus aktif');
    return p;
  }
  // Terapis: direktori ringkas pasien aktif (tanpa harus sudah ditugaskan).
  const p = await db.maybe<{ id: string; fullName: string; patientCode: string }>(
    `SELECT id, full_name, patient_code FROM app_patient_directory(NULL, $1, 1)`,
    [patientId],
  );
  if (!p) throw notFound('Pasien');
  return p;
}

export async function absenRoutes(app: FastifyInstance) {
  // Pencarian pasien untuk absen: No. RM, nama, atau panggilan.
  app.get('/absen/patients', async (req) => {
    const ctx = needTenant(req, 'session.log.own', 'session.complete');
    const { q } = parse(z.object({ q: z.string().trim().min(1).max(100) }), req.query);
    return tenantTx(app, ctx, (db) =>
      can(ctx, 'patient.read')
        ? db.many(
            `SELECT id, patient_code, full_name, nickname, birth_date FROM patients
              WHERE organization_id = $1 AND status = 'aktif' AND anonymized_at IS NULL
                AND (full_name ILIKE $2 OR patient_code ILIKE $2 OR nickname ILIKE $2)
              ORDER BY full_name LIMIT 20`,
            [ctx.orgId, likePattern(q)],
          )
        : db.many(`SELECT * FROM app_patient_directory($1, NULL, 20)`, [likePattern(q)]),
    );
  });

  // Agenda absen satu hari: jadwal yang menunggu absen dan sesi yang sudah diabsen.
  app.get('/absen/agenda', async (req) => {
    const ctx = needTenant(req, 'session.log.own', 'session.complete');
    const q = parse(z.object({ date: zDate.optional() }), req.query);
    const manager = can(ctx, 'session.complete');
    return tenantTx(app, ctx, async (db) => {
      const { today } = await db.one<{ today: string }>(`SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS today`, [ctx.timezone]);
      const date = q.date ?? today;
      const rows = await db.many(
        `SELECT a.id, a.patient_id, p.patient_code, p.full_name AS patient_name, p.nickname, a.service_id, s.name AS service_name,
                to_char(a.starts_at AT TIME ZONE $3, 'HH24:MI') AS local_time, a.status, a.billing,
                a.therapist_member_id, u.full_name AS therapist_name, n.id AS note_id,
                (SELECT count(*)::int FROM session_media sm WHERE sm.organization_id = a.organization_id AND sm.appointment_id = a.id AND sm.archived_at IS NULL) AS media_count
           FROM appointments a
           JOIN patients p ON p.organization_id = a.organization_id AND p.id = a.patient_id
           LEFT JOIN therapy_services s ON s.organization_id = a.organization_id AND s.id = a.service_id
           LEFT JOIN memberships m ON m.organization_id = a.organization_id AND m.id = a.therapist_member_id
           LEFT JOIN users u ON u.id = m.user_id
           LEFT JOIN therapy_notes n ON n.organization_id = a.organization_id AND n.appointment_id = a.id
          WHERE a.organization_id = $1
            AND a.starts_at >= ($2::date)::timestamp AT TIME ZONE $3 AND a.starts_at < ($2::date + 1)::timestamp AT TIME ZONE $3
            AND a.status IN ('terjadwal', 'selesai')
            AND ($4::uuid IS NULL OR a.therapist_member_id = $4)
          ORDER BY a.starts_at`,
        [ctx.orgId, date, ctx.timezone, manager ? null : ctx.memberId],
      );
      // Terapis juga melihat jadwal yang belum memiliki terapis (identitas ringkas saja).
      const open = manager
        ? []
        : await db.many(
            `SELECT id, patient_id, patient_code, full_name AS patient_name, nickname, service_id, service_name,
                    to_char(starts_at AT TIME ZONE $2, 'HH24:MI') AS local_time, 'terjadwal' AS status,
                    NULL::uuid AS therapist_member_id, NULL AS therapist_name, NULL::uuid AS note_id, 0 AS media_count
               FROM app_open_appointments(($1::date)::timestamp AT TIME ZONE $2, ($1::date + 1)::timestamp AT TIME ZONE $2)
              ORDER BY starts_at`,
            [date, ctx.timezone],
          );
      const all = [...rows, ...open] as { status: string; localTime: string }[];
      all.sort((x, y) => x.localTime.localeCompare(y.localTime));
      return {
        date,
        today,
        waiting: all.filter((r) => r.status === 'terjadwal'),
        done: all.filter((r) => r.status === 'selesai'),
      };
    });
  });

  app.post('/absen', async (req, reply) => {
    const ctx = needTenant(req, 'session.log.own', 'session.complete');
    const body = parse(absenBody, req.body);
    const manager = can(ctx, 'session.complete');
    if (!manager && body.therapistMemberId && body.therapistMemberId !== ctx.memberId) {
      throw forbidden('Terapis hanya dapat mengabsen sesinya sendiri');
    }
    const therapistId = (manager ? body.therapistMemberId : null) ?? ctx.memberId;
    if (!therapistId) throw badRequest('Pilih terapis yang menangani sesi');
    const self = therapistId === ctx.memberId;
    const writesNote = Boolean(body.activities || body.homeProgram);
    if (writesNote && !(self && can(ctx, 'therapy.note.write'))) {
      throw forbidden('Aktivitas dan PR ditulis oleh terapis yang menangani sesi');
    }
    if (!manager && !body.activities) throw badRequest('Tuliskan aktivitas sesi');

    const result = await tenantTx(app, ctx, async (db) => {
      await requireTherapist(db, ctx.orgId!, therapistId);
      await patientCard(db, ctx, body.patientId);
      // Terapis yang mengabsen otomatis tertaut ke pasien (dasar akses data & catatannya).
      await linkTherapist(db, ctx, body.patientId, therapistId);
      const now = await db.one<{ d: string; t: string }>(
        `SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS d, to_char(now() AT TIME ZONE $1, 'HH24:MI') AS t`,
        [ctx.timezone],
      );

      let a: ApptRow;
      if (body.appointmentId) {
        a = await lockAppointment(db, ctx, body.appointmentId);
        if (a.patientId !== body.patientId) throw badRequest('Jadwal ini bukan milik pasien tersebut');
        if (a.status !== 'terjadwal') throw conflict('Jadwal ini sudah diabsen atau tidak berstatus terjadwal');
      } else {
        const date = body.date ?? now.d;
        if (date > now.d) throw badRequest('Absen untuk tanggal mendatang belum dapat dicatat');
        const tooOld = await db.one<{ old: boolean }>(`SELECT $1::date < $2::date - $3::int AS old`, [date, now.d, MAX_BACKDATE_DAYS]);
        if (tooOld.old) throw badRequest(`Absen paling lama ${MAX_BACKDATE_DAYS} hari ke belakang`);
        // Jadwal pasien pada tanggal itu yang belum diabsen (tanpa terapis atau milik terapis ini).
        const scheduled = await db.maybe<{ id: string }>(
          `SELECT id FROM appointments
            WHERE organization_id = $1 AND patient_id = $2 AND status = 'terjadwal'
              AND (therapist_member_id IS NULL OR therapist_member_id = $3)
              AND ($4::uuid IS NULL OR service_id IS NULL OR service_id = $4)
              AND starts_at >= ($5::date)::timestamp AT TIME ZONE $6 AND starts_at < ($5::date + 1)::timestamp AT TIME ZONE $6
            ORDER BY starts_at LIMIT 1`,
          [ctx.orgId, body.patientId, therapistId, body.serviceId ?? null, date, ctx.timezone],
        );
        if (scheduled) {
          a = await lockAppointment(db, ctx, scheduled.id);
        } else {
          if (!body.serviceId) throw badRequest('Pilih layanan (mis. OT atau TW)');
          a = await lockAppointment(db, ctx, await createSession(db, req, ctx, { ...body, serviceId: body.serviceId }, therapistId, date, body.time ?? now.t));
        }
      }

      if (!a.serviceId && body.serviceId) {
        const s = await db.maybe(`SELECT 1 FROM therapy_services WHERE organization_id = $1 AND id = $2 AND active`, [ctx.orgId, body.serviceId]);
        if (!s) throw badRequest('Layanan tidak valid atau tidak aktif');
        await db.exec(`UPDATE appointments SET service_id = $3, updated_by = $4 WHERE organization_id = $1 AND id = $2`, [ctx.orgId, a.id, body.serviceId, ctx.userId]);
        a.serviceId = body.serviceId;
      }
      const replaced = a.therapistMemberId && a.therapistMemberId !== therapistId ? a.therapistMemberId : null;
      if (a.therapistMemberId !== therapistId) await setTherapist(db, ctx, a, therapistId);
      const sessionsRemaining = await completeAppointment(db, ctx, a);

      let noteId: string | null = null;
      if (writesNote) {
        const exists = await db.maybe(`SELECT 1 FROM therapy_notes WHERE organization_id = $1 AND appointment_id = $2`, [ctx.orgId, a.id]);
        if (exists) throw conflict('Catatan untuk sesi ini sudah ada');
        const note = await db.one<{ id: string }>(
          `INSERT INTO therapy_notes (organization_id, patient_id, appointment_id, author_member_id, note_type, status, activities, home_program, finalized_at)
           VALUES ($1, $2, $3, $4, 'sesi', 'final', $5, $6, now()) RETURNING id`,
          [ctx.orgId, a.patientId, a.id, ctx.memberId, body.activities, body.homeProgram],
        );
        noteId = note.id;
        await audit(db, req, ctx, { action: 'catatan.dibuat', entityType: 'therapy_note', entityId: note.id, meta: { jenis: 'sesi', status: 'final', pasien_id: a.patientId, lewat: 'absen' } });
      }
      const pkg = a.patientPackageId
        ? await db.maybe<{ name: string }>(`SELECT name FROM patient_packages WHERE organization_id = $1 AND id = $2`, [ctx.orgId, a.patientPackageId])
        : null;
      await audit(db, req, ctx, {
        action: 'sesi.diabsen',
        entityType: 'appointment',
        entityId: a.id,
        meta: { tagihan: a.billing, terapis: therapistId, menggantikan: replaced, kompensasi_dihitung: a.compensated, catatan: Boolean(noteId) },
      });
      return { appointmentId: a.id, noteId, billing: a.billing, price: a.price, packageName: pkg?.name ?? null, sessionsRemaining };
    });
    return reply.status(201).send(result);
  });

  // ---- Video/foto sesi ----
  app.get('/appointments/:id/media', async (req) => {
    const ctx = needTenant(req, 'therapy.note.read', 'therapy.note.read.assigned');
    const id = idParam(req.params);
    return tenantTx(app, ctx, (db) =>
      db.many(
        `SELECT sm.id, sm.kind, sm.mime_type, sm.size_bytes, sm.duration_seconds, sm.uploaded_at, sm.uploader_member_id, u.full_name AS uploader_name
           FROM session_media sm LEFT JOIN users u ON u.id = sm.uploaded_by
          WHERE sm.organization_id = $1 AND sm.appointment_id = $2 AND sm.archived_at IS NULL
          ORDER BY sm.uploaded_at`,
        [ctx.orgId, id],
      ),
    );
  });

  app.post('/appointments/:id/media', async (req, reply) => {
    const ctx = needTenant(req, 'session.media.upload');
    if (!ctx.memberId) throw forbidden();
    const id = idParam(req.params);
    const part = await req.file();
    if (!part) throw badRequest('Berkas belum dipilih');
    const buf = await part.toBuffer();
    if (part.file.truncated) throw new HttpError(413, `Ukuran berkas melebihi ${Math.round(app.config.maxUploadBytes / 1024 / 1024)} MB`, 'too_large');
    if (buf.length === 0) throw badRequest('Berkas kosong');
    const type = sniffMedia(buf);
    if (type === 'heic') throw badRequest('Foto HEIC belum didukung. Ubah format kamera ke JPG ("Paling Kompatibel") lalu ambil ulang.');
    if (!type) throw badRequest('Jenis berkas tidak didukung. Gunakan video MP4/MOV atau foto JPG/PNG.');
    let duration: number | null = null;
    if (type.kind === 'video') {
      duration = mp4Duration(buf);
      if (duration === null) throw badRequest('Durasi video tidak terbaca. Rekam ulang dengan kamera HP (MP4/MOV).');
      if (duration < MIN_VIDEO_SECONDS) throw badRequest(`Video minimal ${MIN_VIDEO_SECONDS} detik (video ini ${Math.floor(duration)} detik)`);
    }

    const prepare = async (db: Db) => {
      const a = await db.maybe<{ patientId: string; status: string; therapistMemberId: string | null }>(
        `SELECT patient_id, status, therapist_member_id FROM appointments WHERE organization_id = $1 AND id = $2`,
        [ctx.orgId, id],
      );
      if (!a) throw notFound('Sesi');
      if (a.status !== 'selesai') throw conflict('Video/foto hanya dapat ditambahkan pada sesi yang sudah diabsen');
      if (a.therapistMemberId !== ctx.memberId && !can(ctx, 'therapy.note.read')) throw forbidden('Hanya terapis yang menangani sesi yang dapat menambahkan video/foto');
      const { n } = await db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM session_media WHERE organization_id = $1 AND appointment_id = $2 AND archived_at IS NULL`,
        [ctx.orgId, id],
      );
      if (n >= MAX_MEDIA_PER_SESSION) throw conflict(`Maksimal ${MAX_MEDIA_PER_SESSION} video/foto per sesi`);
      const { used } = await db.one<{ used: number }>(`SELECT org_storage_bytes() AS used`);
      if (used + buf.length > app.config.orgStorageQuotaBytes) {
        throw new HttpError(413, 'Kuota penyimpanan organisasi sudah penuh. Hubungi owner.', 'quota_exceeded');
      }
      return a;
    };
    await tenantTx(app, ctx, prepare);

    const storageKey = `${ctx.orgId}/sesi/${randomUUID()}${type.ext}`;
    await app.fileStore.put(storageKey, buf, type.mime);
    try {
      const row = await tenantTx(app, ctx, async (db) => {
        await db.exec(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`storage:${ctx.orgId}`]);
        const a = await prepare(db);
        const m = await db.one<{ id: string }>(
          `INSERT INTO session_media (organization_id, patient_id, appointment_id, uploader_member_id, kind, mime_type, size_bytes, duration_seconds, storage_key, sha256, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [ctx.orgId, a.patientId, id, ctx.memberId, type.kind, type.mime, buf.length, duration === null ? null : Math.round(duration * 10) / 10, storageKey, createHash('sha256').update(buf).digest('hex'), ctx.userId],
        );
        await audit(db, req, ctx, { action: 'media_sesi.diunggah', entityType: 'appointment', entityId: id, meta: { media_id: m.id, jenis: type.kind } });
        return m;
      });
      return reply.status(201).send(row);
    } catch (err) {
      await app.fileStore.remove(storageKey).catch((e) => req.log.error({ err: { message: (e as Error).message } }, 'gagal menghapus berkas yatim'));
      throw err;
    }
  });

  // Diputar langsung di browser (mendukung Range agar video dapat digeser).
  app.get('/media/:id', async (req, reply) => {
    const ctx = needTenant(req, 'therapy.note.read', 'therapy.note.read.assigned');
    const id = idParam(req.params);
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    const first = !range || range[1] === '0' || range[1] === '';
    const m = await tenantTx(app, ctx, async (db) => {
      const row = await db.maybe<{ storageKey: string; mimeType: string; appointmentId: string }>(
        `SELECT storage_key, mime_type, appointment_id FROM session_media WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL`,
        [ctx.orgId, id],
      );
      if (!row) throw notFound('Video/foto');
      if (first) await audit(db, req, ctx, { action: 'media_sesi.dilihat', entityType: 'appointment', entityId: row.appointmentId, meta: { media_id: id } });
      return row;
    });
    if (!m.storageKey.startsWith(`${ctx.orgId}/`)) throw notFound('Video/foto');
    const data = await app.fileStore.get(m.storageKey);
    // Video MOV (H.264) dapat diputar browser bila dikirim sebagai MP4.
    reply
      .header('Content-Type', m.mimeType === 'video/quicktime' ? 'video/mp4' : m.mimeType)
      .header('Content-Disposition', 'inline')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Accept-Ranges', 'bytes');
    if (range && (range[1] || range[2])) {
      const size = data.length;
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : size - 1;
      start = Math.max(0, start);
      end = Math.min(end, size - 1);
      if (start > end || start >= size) return reply.status(416).header('Content-Range', `bytes */${size}`).send();
      return reply.status(206).header('Content-Range', `bytes ${start}-${end}/${size}`).send(data.subarray(start, end + 1));
    }
    return reply.send(data);
  });

  app.post('/media/:id/archive', async (req) => {
    const ctx = needTenant(req, 'session.media.upload');
    const id = idParam(req.params);
    await tenantTx(app, ctx, async (db) => {
      const m = await db.maybe<{ uploaderMemberId: string; appointmentId: string }>(
        `SELECT uploader_member_id, appointment_id FROM session_media WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL FOR UPDATE`,
        [ctx.orgId, id],
      );
      if (!m) throw notFound('Video/foto');
      if (m.uploaderMemberId !== ctx.memberId && !can(ctx, 'therapy.note.read')) throw forbidden('Hanya pengunggah atau owner yang dapat menghapus video/foto ini');
      await db.exec(`UPDATE session_media SET archived_at = now(), archived_by = $3 WHERE organization_id = $1 AND id = $2`, [ctx.orgId, id, ctx.userId]);
      await audit(db, req, ctx, { action: 'media_sesi.dihapus', entityType: 'appointment', entityId: m.appointmentId, meta: { media_id: id } });
    });
    return { ok: true };
  });
}

// Sesi baru dari absen: paket aktif untuk layanan itu (atau paket umum) dipakai lebih dulu;
// tanpa paket, tercatat per sesi dengan tarif layanan.
async function createSession(
  db: Db,
  req: FastifyRequest,
  ctx: AuthContext,
  body: { patientId: string; serviceId: string },
  therapistId: string,
  date: string,
  time: string,
): Promise<string> {
  const s = await db.maybe<{ defaultDurationMinutes: number; defaultPrice: number }>(
    `SELECT default_duration_minutes, default_price FROM therapy_services WHERE organization_id = $1 AND id = $2 AND active`,
    [ctx.orgId, body.serviceId],
  );
  if (!s) throw badRequest('Layanan tidak valid atau tidak aktif');
  const pkg = await db.maybe<{ id: string }>(
    `SELECT id FROM patient_packages
      WHERE organization_id = $1 AND patient_id = $2 AND status = 'aktif' AND sessions_used < sessions_total
        AND (expires_on IS NULL OR expires_on >= $4::date)
        AND (service_id = $3 OR service_id IS NULL)
      ORDER BY (service_id IS NULL), expires_on NULLS LAST, purchased_on, created_at
      LIMIT 1`,
    [ctx.orgId, body.patientId, body.serviceId, date],
  );
  // Sesi yang sama (pasien, layanan, terapis, tanggal) tidak diabsen dua kali.
  const dup = await db.maybe(
    `SELECT 1 FROM appointments
      WHERE organization_id = $1 AND patient_id = $2 AND therapist_member_id = $3 AND service_id = $4 AND status = 'selesai'
        AND starts_at >= ($5::date)::timestamp AT TIME ZONE $6 AND starts_at < ($5::date + 1)::timestamp AT TIME ZONE $6`,
    [ctx.orgId, body.patientId, therapistId, body.serviceId, date, ctx.timezone],
  );
  if (dup) throw conflict('Sesi layanan ini sudah diabsen untuk pasien tersebut pada tanggal itu');
  const startsAt = await toTimestamp(db, date, time, ctx.timezone);
  const row = await db.one<{ id: string }>(
    `INSERT INTO appointments
       (organization_id, patient_id, therapist_member_id, service_id, starts_at, duration_minutes, billing, patient_package_id, price, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING id`,
    [ctx.orgId, body.patientId, therapistId, body.serviceId, startsAt, s.defaultDurationMinutes, pkg ? 'paket' : 'per_sesi', pkg?.id ?? null, pkg ? 0 : s.defaultPrice, ctx.userId],
  );
  await audit(db, req, ctx, { action: 'jadwal.dibuat', entityType: 'appointment', entityId: row.id, meta: { lewat: 'absen' } });
  return row.id;
}
