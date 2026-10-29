import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, writeAudit } from '../audit.ts';
import { needTenant, systemTenantTx, tenantTx } from '../authz/context.ts';
import { withTx, type Db } from '../db.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import { parse, zDate } from '../http.ts';
import { fonnteDevice, fonnteSend, type FonnteOptions } from '../lib/fonnte.ts';
import { openSecret, sealSecret } from '../security/secret-box.ts';
import { AUTO_MAX_ATTEMPTS, autoEligible, loadReminders, normalizePhone, type ReminderGroup } from './reminders.ts';

// WhatsApp otomatis lewat Fonnte. Setiap organisasi memakai nomor & token Fonnte-nya sendiri.
// Cron (GET /api/cron/reminders, tiap ~10 menit) mengirim satu pesan per anak per hari, `lead_minutes`
// menit sebelum sesi pertamanya yang belum diingatkan; kebijakan menit ini diatur owner masing-masing.

// Batas waktu kerja satu putaran agar tidak melewati batas durasi fungsi serverless.
const RUN_BUDGET_MS = 20_000;

interface WaRow {
  tokenCiphertext: string;
  tokenHint: string;
  autoEnabled: boolean;
  leadMinutes: number;
  deviceNumber: string | null;
  deviceStatus: string | null;
  checkedAt: Date | null;
  updatedAt: Date;
}

type Runner = <T>(fn: (db: Db) => Promise<T>) => Promise<T>;
type Counts = { terkirim: number; gagal: number; tidak_pasti: number; dilewati: number; tertunda: number };

const settingsBody = z.object({
  token: z.string().trim().min(5, 'Token terlalu pendek').max(200).optional(),
  autoEnabled: z.boolean(),
  leadMinutes: z.number().int().min(30, 'Minimal 30 menit sebelum jadwal').max(2880, 'Maksimal 48 jam sebelum jadwal'),
});

const fonnte = (app: FastifyInstance): FonnteOptions => ({ baseUrl: app.config.whatsapp.fonnteApiUrl, timeoutMs: app.config.whatsapp.timeoutMs });

function requireKey(app: FastifyInstance): Buffer {
  const key = app.config.whatsapp.encryptionKey;
  if (!key) throw new HttpError(503, 'Server belum disiapkan untuk WhatsApp otomatis (APP_ENCRYPTION_KEY belum diisi).', 'not_configured');
  return key;
}

const loadWa = (db: Db, orgId: string) =>
  db.maybe<WaRow>(
    `SELECT token_ciphertext, token_hint, auto_enabled, lead_minutes, device_number, device_status, checked_at, updated_at
       FROM org_whatsapp WHERE organization_id = $1`,
    [orgId],
  );

function view(app: FastifyInstance, wa: WaRow | null) {
  return {
    serverReady: Boolean(app.config.whatsapp.encryptionKey),
    cronReady: Boolean(app.config.whatsapp.cronSecret),
    configured: Boolean(wa),
    tokenHint: wa ? `••••${wa.tokenHint}` : null,
    autoEnabled: wa?.autoEnabled ?? false,
    leadMinutes: wa?.leadMinutes ?? 180,
    deviceNumber: wa?.deviceNumber ?? null,
    deviceStatus: wa?.deviceStatus ?? null,
    checkedAt: wa?.checkedAt ?? null,
    updatedAt: wa?.updatedAt ?? null,
  };
}

// Klaim -> kirim -> catat hasil, satu pesan per anak per hari. Klaim (status 'mengirim') untuk semua
// sesi yang layak di-commit sebelum memanggil Fonnte sehingga dua proses bersamaan tidak mengirim
// pesan yang sama. Hasil kiriman dicatat pada setiap sesi yang diklaim.
async function deliver(app: FastifyInstance, run: Runner, orgId: string, token: string, groups: ReminderGroup[], sentBy: string | null): Promise<Counts> {
  const counts: Counts = { terkirim: 0, gagal: 0, tidak_pasti: 0, dilewati: 0, tertunda: 0 };
  const deadline = Date.now() + RUN_BUDGET_MS;
  const gap = app.config.whatsapp.sendGapSeconds;
  let queued = 0;
  for (const g of groups) {
    const eligible = g.sessions.filter((s) => autoEligible(g, s));
    if (eligible.length === 0) {
      counts.dilewati++;
      continue;
    }
    if (Date.now() > deadline) {
      counts.tertunda++;
      continue;
    }
    const claimed = await run(async (db) => {
      const ids: string[] = [];
      for (const s of eligible) {
        const row = await db.maybe<{ id: string }>(
          `INSERT INTO notification_log (organization_id, patient_id, appointment_id, channel, status, sent_by)
           VALUES ($1, $2, $3, 'whatsapp_otomatis', 'mengirim', $4)
           ON CONFLICT (organization_id, appointment_id, channel) DO UPDATE
             SET status = 'mengirim', attempts = notification_log.attempts + 1, failure_reason = NULL, sent_at = now()
             WHERE notification_log.status = 'gagal' AND notification_log.attempts < $5
           RETURNING id`,
          [orgId, g.patientId, s.appointmentId, sentBy, AUTO_MAX_ATTEMPTS],
        );
        if (row) ids.push(row.id);
      }
      return ids;
    });
    if (claimed.length === 0) {
      counts.dilewati++;
      continue;
    }
    // Pesan berikutnya dijadwalkan berjarak di Fonnte agar tidak terkirim beruntun dari satu nomor.
    const schedule = gap > 0 && queued > 0 ? Math.floor(Date.now() / 1000) + queued * gap : undefined;
    const r = await fonnteSend(fonnte(app), token, { target: g.phone!, message: g.message, schedule });
    queued++;
    await run((db) =>
      db.exec(
        `UPDATE notification_log SET status = $3, provider_message_id = $4, failure_reason = $5, sent_at = now()
          WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
        [orgId, claimed, r.outcome, r.outcome === 'terkirim' ? r.providerId : null, r.outcome === 'terkirim' ? null : r.reason],
      ),
    );
    counts[r.outcome]++;
  }
  return counts;
}

function bearerMatches(header: unknown, secret: string): boolean {
  const given = Buffer.from(typeof header === 'string' ? header : '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function whatsappRoutes(app: FastifyInstance) {
  app.get('/org/whatsapp', async (req) => {
    const ctx = needTenant(req, 'whatsapp.manage');
    return view(app, await tenantTx(app, ctx, (db) => loadWa(db, ctx.orgId!)));
  });

  app.put('/org/whatsapp', async (req) => {
    const ctx = needTenant(req, 'whatsapp.manage');
    const body = parse(settingsBody, req.body);
    const key = requireKey(app);
    // Token baru diperiksa ke Fonnte lebih dulu (di luar transaksi database).
    const device = body.token ? await fonnteDevice(fonnte(app), body.token) : null;
    if (device && !device.ok) throw badRequest(`Token ditolak Fonnte: ${device.reason}`);
    const wa = await tenantTx(app, ctx, async (db) => {
      const before = await loadWa(db, ctx.orgId!);
      if (!before && !body.token) throw badRequest('Masukkan token Fonnte untuk menghubungkan WhatsApp');
      if (body.token && device) {
        await db.exec(
          `INSERT INTO org_whatsapp (organization_id, token_ciphertext, token_hint, auto_enabled, lead_minutes,
                                     device_number, device_status, checked_at, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
           ON CONFLICT (organization_id) DO UPDATE
             SET token_ciphertext = EXCLUDED.token_ciphertext, token_hint = EXCLUDED.token_hint,
                 auto_enabled = EXCLUDED.auto_enabled, lead_minutes = EXCLUDED.lead_minutes,
                 device_number = EXCLUDED.device_number, device_status = EXCLUDED.device_status,
                 checked_at = now(), updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [
            ctx.orgId,
            sealSecret(key, body.token, ctx.orgId!),
            body.token.slice(-4),
            body.autoEnabled,
            body.leadMinutes,
            device.device,
            device.connected ? 'connect' : 'disconnect',
            ctx.userId,
          ],
        );
      } else {
        await db.exec(
          `UPDATE org_whatsapp SET auto_enabled = $2, lead_minutes = $3, updated_at = now(), updated_by = $4 WHERE organization_id = $1`,
          [ctx.orgId, body.autoEnabled, body.leadMinutes, ctx.userId],
        );
      }
      await audit(db, req, ctx, {
        action: 'whatsapp.diatur',
        entityType: 'organization',
        entityId: ctx.orgId,
        meta: { token_diganti: Boolean(body.token), otomatis: body.autoEnabled, menit_sebelum_jadwal: body.leadMinutes },
      });
      return loadWa(db, ctx.orgId!);
    });
    return view(app, wa);
  });

  app.delete('/org/whatsapp', async (req) => {
    const ctx = needTenant(req, 'whatsapp.manage');
    await tenantTx(app, ctx, async (db) => {
      const n = await db.exec(`DELETE FROM org_whatsapp WHERE organization_id = $1`, [ctx.orgId]);
      if (n > 0) await audit(db, req, ctx, { action: 'whatsapp.diputus', entityType: 'organization', entityId: ctx.orgId });
    });
    return view(app, null);
  });

  async function tokenFor(ctxOrg: string, run: Runner): Promise<{ wa: WaRow; token: string }> {
    const key = requireKey(app);
    const wa = await run((db) => loadWa(db, ctxOrg));
    if (!wa) throw badRequest('WhatsApp otomatis belum dihubungkan. Owner dapat mengaturnya di Pengaturan → WhatsApp.');
    return { wa, token: openSecret(key, wa.tokenCiphertext, ctxOrg) };
  }

  app.post('/org/whatsapp/check', async (req) => {
    const ctx = needTenant(req, 'whatsapp.manage');
    const run: Runner = (fn) => tenantTx(app, ctx, fn);
    const { token } = await tokenFor(ctx.orgId!, run);
    const device = await fonnteDevice(fonnte(app), token);
    const wa = await run(async (db) => {
      if (device.ok) {
        await db.exec(
          `UPDATE org_whatsapp SET device_number = $2, device_status = $3, checked_at = now() WHERE organization_id = $1`,
          [ctx.orgId, device.device, device.connected ? 'connect' : 'disconnect'],
        );
      }
      return loadWa(db, ctx.orgId!);
    });
    return { ...view(app, wa), check: { ok: device.ok, reason: device.reason, connected: device.connected, quota: device.quota, expired: device.expired, plan: device.plan } };
  });

  app.post('/org/whatsapp/test', async (req) => {
    const ctx = needTenant(req, 'whatsapp.manage');
    const { phone } = parse(z.object({ phone: z.string().max(40) }), req.body);
    const target = normalizePhone(phone);
    if (!target) throw badRequest('Nomor WhatsApp tidak valid');
    const run: Runner = (fn) => tenantTx(app, ctx, fn);
    const { token } = await tokenFor(ctx.orgId!, run);
    const r = await fonnteSend(fonnte(app), token, {
      target,
      message: `Pesan uji dari ${ctx.orgName}: pengingat WhatsApp otomatis sudah tersambung. Abaikan pesan ini.`,
    });
    await run((db) => audit(db, req, ctx, { action: 'whatsapp.uji', entityType: 'organization', entityId: ctx.orgId, meta: { hasil: r.outcome } }));
    return { outcome: r.outcome, reason: r.outcome === 'terkirim' ? null : r.reason };
  });

  // Kirim sekarang semua pengingat yang belum terkirim untuk satu tanggal (atas perintah petugas).
  app.post('/reminders/auto-send', async (req) => {
    const ctx = needTenant(req, 'reminder.send');
    const { date } = parse(z.object({ date: zDate }), req.body);
    const run: Runner = (fn) => tenantTx(app, ctx, fn);
    const { token } = await tokenFor(ctx.orgId!, run);
    const groups = await run((db) => loadReminders(db, ctx.orgId!, ctx.timezone, { date, upcomingOnly: true }));
    const counts = await deliver(app, run, ctx.orgId!, token, groups, ctx.userId);
    await run((db) => audit(db, req, ctx, { action: 'pengingat.otomatis', meta: { ...counts, sumber: 'manual', tanggal: date } }));
    return counts;
  });

  // Dipanggil penjadwal (Vercel Cron / penjadwal eksternal) dengan Authorization: Bearer CRON_SECRET.
  app.get('/cron/reminders', async (req) => {
    const secret = app.config.whatsapp.cronSecret;
    const key = app.config.whatsapp.encryptionKey;
    if (!secret || !key) throw notFound('Halaman');
    if (!bearerMatches(req.headers.authorization, secret)) throw new HttpError(401, 'Tidak diizinkan', 'unauthorized');
    const orgs = await withTx(app.pool, { settings: { 'app.mode': 'platform' } }, (db) =>
      db.many<{ id: string; timezone: string }>(`SELECT id, timezone FROM organizations WHERE status = 'active' ORDER BY created_at`),
    );
    const total = { organisasi: 0, terkirim: 0, gagal: 0, tidak_pasti: 0, dilewati: 0, tertunda: 0 };
    for (const org of orgs) {
      const run: Runner = (fn) => systemTenantTx(app, org.id, fn);
      try {
        const wa = await run((db) => loadWa(db, org.id));
        if (!wa?.autoEnabled) continue;
        const token = openSecret(key, wa.tokenCiphertext, org.id);
        const groups = await run((db) => loadReminders(db, org.id, org.timezone, { dueWithinMinutes: wa.leadMinutes }));
        const counts = await deliver(app, run, org.id, token, groups, null);
        total.organisasi++;
        for (const k of Object.keys(counts) as (keyof Counts)[]) total[k] += counts[k];
        if (counts.terkirim + counts.gagal + counts.tidak_pasti > 0) {
          await run((db) => writeAudit(db, null, { orgId: org.id, userId: null }, { action: 'pengingat.otomatis', meta: { ...counts, sumber: 'jadwal' } }));
        }
      } catch (err) {
        // Kegagalan satu organisasi tidak menghentikan organisasi lain. Tanpa data pasien di log.
        req.log.error({ err: { message: (err as Error).message } }, 'pengingat otomatis gagal untuk satu organisasi');
      }
    }
    return total;
  });
}
