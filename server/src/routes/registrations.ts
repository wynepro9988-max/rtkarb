import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { can, needTenant, tenantTx } from '../authz/context.ts';
import { withTx } from '../db.ts';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../errors.ts';
import { idParam, parse, zDate, zText, zTime } from '../http.ts';
import { sniffMedia } from '../lib/media.ts';
import { newToken } from '../security/tokens.ts';
import { normalizePhone } from './reminders.ts';

// Pendaftaran online (pengganti Google Form, keputusan owner 5 Nov 2026). Orang tua mengisi
// halaman publik tanpa akun; admin/owner memeriksa lalu menerima (menjadi pasien) atau menolak.

const UNAVAILABLE = 'Pendaftaran online tidak tersedia. Hubungi admin klinik.';
// Brosur tampil di halaman publik yang dibuka dari HP: dibatasi agar tetap ringan.
const MAX_FLYER_BYTES = 5 * 1024 * 1024;

const publicBody = z.object({
  childName: zText(2, 150),
  birthPlace: zText(2, 100),
  birthDate: zDate,
  guardianName: zText(2, 150),
  relationship: z.enum(['Ibu', 'Ayah', 'Wali']),
  phone: z.string().trim().min(8).max(40),
  address: zText(3, 500),
  complaint: zText(2, 2000),
  assessmentDate: zDate,
  assessmentTime: zTime,
  agree: z.literal(true, 'Centang persetujuan terlebih dahulu'),
  // Jebakan bot: kolom tersembunyi yang tidak terlihat oleh manusia.
  website: z.string().max(200).optional(),
});

const tokenParam = (params: unknown) => {
  const t = (params as { token?: unknown }).token;
  if (typeof t !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(t)) throw notFound();
  return t;
};

export async function registrationRoutes(app: FastifyInstance) {
  const strict = { config: { rateLimit: { max: app.config.authRateLimitPerMinute, timeWindow: '1 minute' } } };
  const info = (token: string) =>
    withTx(app.pool, {}, (db) =>
      db.maybe<{
        organizationName: string;
        isOpen: boolean;
        today: string;
        flyerKey: string | null;
        flyerMime: string | null;
        flyerVersion: number | null;
        organizationPhone: string | null;
        organizationAddress: string | null;
      }>(
        `SELECT organization_name, is_open, to_char(today, 'YYYY-MM-DD') AS today, flyer_key, flyer_mime, flyer_version,
                organization_phone, organization_address
           FROM public_registration_info($1)`,
        [token],
      ),
    );

  // ---- Halaman publik ----
  app.get('/public/registration/:token', strict, async (req) => {
    const i = await info(tokenParam(req.params));
    if (!i || !i.isOpen) throw new HttpError(404, UNAVAILABLE, 'not_found');
    return {
      organizationName: i.organizationName,
      today: i.today,
      flyerVersion: i.flyerKey ? i.flyerVersion : null,
      // Kontak klinik dari Pengaturan; nomor WA hanya bila dapat dipakai untuk wa.me.
      contact: { phone: i.organizationPhone, whatsapp: normalizePhone(i.organizationPhone), address: i.organizationAddress },
    };
  });

  // Brosur paket layanan & harga di halaman pendaftaran (hanya selama pendaftaran dibuka).
  app.get('/public/registration/:token/flyer', strict, async (req, reply) => {
    const i = await info(tokenParam(req.params));
    if (!i || !i.isOpen || !i.flyerKey || !i.flyerMime) throw notFound();
    const data = await app.fileStore.get(i.flyerKey);
    return reply
      .header('Content-Type', i.flyerMime)
      .header('Content-Disposition', 'inline')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'public, max-age=300')
      .send(data);
  });

  app.post('/public/registration/:token', strict, async (req, reply) => {
    const token = tokenParam(req.params);
    const body = parse(publicBody, req.body);
    // Kiriman bot dijawab seolah berhasil, tetapi tidak disimpan.
    if (body.website) return reply.status(201).send({ ok: true });
    const phone = normalizePhone(body.phone);
    if (!phone) throw badRequest('Nomor WhatsApp tidak valid. Contoh: 0812xxxxxxx');
    const i = await info(token);
    if (!i || !i.isOpen) throw new HttpError(404, UNAVAILABLE, 'not_found');
    if (body.birthDate > i.today) throw badRequest('Tanggal lahir tidak boleh di masa depan');
    if (body.assessmentDate < i.today) throw badRequest('Hari pemeriksaan asesmen tidak boleh sebelum hari ini');
    try {
      await withTx(app.pool, {}, (db) =>
        db.one(`SELECT submit_registration($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) AS id`, [
          token,
          body.childName,
          body.birthPlace,
          body.birthDate,
          body.guardianName,
          body.relationship,
          phone,
          body.address,
          body.complaint,
          body.assessmentDate,
          body.assessmentTime,
        ]),
      );
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P0002') throw new HttpError(404, UNAVAILABLE, 'not_found');
      if (code === '54000') throw new HttpError(503, 'Pendaftaran sedang penuh. Silakan hubungi admin klinik lewat WhatsApp.', 'busy');
      throw err;
    }
    return reply.status(201).send({ ok: true });
  });

  // ---- Pengaturan tautan (owner membuka/menutup; admin menyalin tautan) ----
  app.get('/org/registration-link', async (req) => {
    const ctx = needTenant(req, 'patient.manage', 'org.settings.manage');
    return tenantTx(app, ctx, (db) =>
      db.one(
        `SELECT registration_open AS open, registration_token AS token, registration_flyer_key IS NOT NULL AS has_flyer
           FROM organizations WHERE id = $1`,
        [ctx.orgId],
      ),
    );
  });

  app.put('/org/registration-link', async (req) => {
    const ctx = needTenant(req, 'org.settings.manage');
    const body = parse(z.object({ open: z.boolean(), regenerate: z.boolean().default(false) }), req.body);
    return tenantTx(app, ctx, async (db) => {
      const cur = await db.one<{ token: string | null }>(`SELECT registration_token AS token FROM organizations WHERE id = $1 FOR UPDATE`, [ctx.orgId]);
      const token = body.regenerate || (body.open && !cur.token) ? newToken(24) : cur.token;
      const row = await db.one(
        `UPDATE organizations SET registration_open = $2, registration_token = $3 WHERE id = $1
         RETURNING registration_open AS open, registration_token AS token`,
        [ctx.orgId, body.open, token],
      );
      await audit(db, req, ctx, {
        action: 'pendaftaran_online.diatur',
        entityType: 'organization',
        entityId: ctx.orgId,
        meta: { dibuka: body.open, tautan_baru: token !== cur.token },
      });
      return row;
    });
  });

  // ---- Brosur (owner) ----
  app.put('/org/registration-flyer', async (req) => {
    const ctx = needTenant(req, 'org.settings.manage');
    const part = await req.file();
    if (!part) throw badRequest('Berkas belum dipilih');
    const buf = await part.toBuffer();
    if (part.file.truncated || buf.length > MAX_FLYER_BYTES) throw new HttpError(413, 'Ukuran brosur maksimal 5 MB', 'too_large');
    const type = sniffMedia(buf);
    if (!type || type === 'heic' || type.kind !== 'foto') throw badRequest('Brosur harus berupa gambar JPG, PNG, atau WebP');
    const key = `${ctx.orgId}/brosur/${randomUUID()}${type.ext}`;
    await app.fileStore.put(key, buf, type.mime);
    let old: string | null = null;
    try {
      await tenantTx(app, ctx, async (db) => {
        old = (await db.one<{ key: string | null }>(`SELECT registration_flyer_key AS key FROM organizations WHERE id = $1 FOR UPDATE`, [ctx.orgId])).key;
        await db.exec(
          `UPDATE organizations SET registration_flyer_key = $2, registration_flyer_mime = $3, registration_flyer_updated_at = now() WHERE id = $1`,
          [ctx.orgId, key, type.mime],
        );
        await audit(db, req, ctx, { action: 'pendaftaran_online.brosur_diganti', entityType: 'organization', entityId: ctx.orgId });
      });
    } catch (err) {
      await app.fileStore.remove(key).catch(() => undefined);
      throw err;
    }
    if (old) await app.fileStore.remove(old).catch((e) => req.log.error({ err: { message: (e as Error).message } }, 'gagal menghapus brosur lama'));
    return { ok: true };
  });

  app.delete('/org/registration-flyer', async (req) => {
    const ctx = needTenant(req, 'org.settings.manage');
    const old = await tenantTx(app, ctx, async (db) => {
      const r = await db.one<{ key: string | null }>(`SELECT registration_flyer_key AS key FROM organizations WHERE id = $1 FOR UPDATE`, [ctx.orgId]);
      await db.exec(
        `UPDATE organizations SET registration_flyer_key = NULL, registration_flyer_mime = NULL, registration_flyer_updated_at = now() WHERE id = $1`,
        [ctx.orgId],
      );
      await audit(db, req, ctx, { action: 'pendaftaran_online.brosur_dihapus', entityType: 'organization', entityId: ctx.orgId });
      return r.key;
    });
    if (old) await app.fileStore.remove(old).catch((e) => req.log.error({ err: { message: (e as Error).message } }, 'gagal menghapus brosur lama'));
    return { ok: true };
  });

  // ---- Pendaftaran masuk ----
  const needReviewer = (req: Parameters<typeof needTenant>[0]) => {
    const ctx = needTenant(req, 'patient.manage');
    if (!can(ctx, 'patient.intake')) throw forbidden();
    return ctx;
  };

  app.get('/registrations', async (req) => {
    const ctx = needReviewer(req);
    const q = parse(z.object({ status: z.enum(['baru', 'diterima', 'ditolak']).default('baru') }), req.query);
    return tenantTx(app, ctx, (db) =>
      db.many(
        `SELECT r.id, r.child_name, r.birth_place, r.birth_date, r.guardian_name, r.guardian_relationship, r.phone, r.address,
                r.complaint, r.assessment_date, to_char(r.assessment_time, 'HH24:MI') AS assessment_time, r.status, r.reject_reason,
                r.created_at, r.decided_at, r.patient_id, p.patient_code,
                -- Petunjuk kemungkinan pendaftaran ganda: nama & tanggal lahir sama dengan pasien yang ada.
                (SELECT x.patient_code FROM patients x
                  WHERE x.organization_id = r.organization_id AND lower(x.full_name) = lower(r.child_name)
                    AND (x.birth_date IS NULL OR x.birth_date = r.birth_date) AND x.id IS DISTINCT FROM r.patient_id
                  LIMIT 1) AS existing_patient_code,
                -- Kiriman lain yang masih menunggu untuk anak yang sama (mis. tombol Kirim ditekan dua kali).
                (SELECT count(*)::int FROM registration_requests y
                  WHERE y.organization_id = r.organization_id AND y.status = 'baru' AND y.id <> r.id
                    AND lower(y.child_name) = lower(r.child_name) AND y.birth_date = r.birth_date) AS duplicate_requests
           FROM registration_requests r
           LEFT JOIN patients p ON p.organization_id = r.organization_id AND p.id = r.patient_id
          WHERE r.organization_id = $1 AND r.status = $2
          ORDER BY CASE WHEN $2 = 'baru' THEN r.created_at END ASC, r.decided_at DESC NULLS LAST
          LIMIT 200`,
        [ctx.orgId, q.status],
      ),
    );
  });

  app.post('/registrations/:id/reject', async (req) => {
    const ctx = needReviewer(req);
    const id = idParam(req.params);
    const { reason } = parse(z.object({ reason: zText(3, 300) }), req.body);
    await tenantTx(app, ctx, async (db) => {
      const n = await db.exec(
        `UPDATE registration_requests SET status = 'ditolak', reject_reason = $3, decided_by = $4, decided_at = now()
          WHERE organization_id = $1 AND id = $2 AND status = 'baru'`,
        [ctx.orgId, id, reason, ctx.userId],
      );
      if (n === 0) throw conflict('Pendaftaran ini tidak ditemukan atau sudah diproses');
      await audit(db, req, ctx, { action: 'pendaftaran_online.ditolak', entityType: 'registration_request', entityId: id });
    });
    return { ok: true };
  });
}
