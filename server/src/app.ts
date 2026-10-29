import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from './audit.ts';
import { checkCsrf, resolveAuth } from './authz/context.ts';
import type { Config } from './config.ts';
import { withTx, type Pool } from './db.ts';
import { forbidden, HttpError } from './errors.ts';
import { createFileStore, type FileStore } from './lib/storage.ts';
import { appointmentRoutes } from './routes/appointments.ts';
import { auditLogRoutes } from './routes/audit-log.ts';
import { authRoutes } from './routes/auth.ts';
import { compensationRoutes } from './routes/compensation.ts';
import { dashboardRoutes } from './routes/dashboard.ts';
import { documentRoutes } from './routes/documents.ts';
import { financeRoutes } from './routes/finance.ts';
import { noteRoutes } from './routes/notes.ts';
import { orgRoutes } from './routes/org.ts';
import { packageRoutes } from './routes/packages.ts';
import { patientRoutes } from './routes/patients.ts';
import { reportRoutes } from './routes/reports.ts';
import { staffRoutes } from './routes/staff.ts';
import { supportRoutes } from './routes/support.ts';
import { invoiceRoutes } from './routes/invoices.ts';
import { privacyRoutes } from './routes/privacy.ts';
import { programRoutes } from './routes/programs.ts';
import { reconciliationRoutes } from './routes/reconciliation.ts';
import { refundRoutes } from './routes/refunds.ts';
import { reminderRoutes } from './routes/reminders.ts';
import { whatsappRoutes } from './routes/whatsapp.ts';

z.config(z.locales.id());

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Endpoint publik yang tidak memakai sesi berjalan (tetap terkena pemeriksaan Origin).
const NO_SESSION_ROUTES = new Set(['/api/auth/login', '/api/auth/token-info', '/api/auth/accept-invitation', '/api/auth/reset-password', '/api/cron/reminders']);

// Kode error PostgreSQL -> respons aman tanpa detail internal (nilai data tidak dikirim/dicatat).
const PG_ERRORS: Record<string, [number, string]> = {
  '23505': [409, 'Data yang sama sudah ada'],
  '23503': [400, 'Relasi data tidak valid'],
  '23514': [400, 'Data tidak memenuhi aturan yang berlaku'],
  '23502': [400, 'Ada data wajib yang belum diisi'],
  '22P02': [400, 'Format data tidak valid'],
  '22001': [400, 'Isian terlalu panjang'],
  '42501': [403, 'Tindakan tidak diizinkan'],
  '25006': [403, 'Mode dukungan teknis hanya dapat membaca data'],
  '40001': [409, 'Data sedang diubah oleh pengguna lain. Silakan coba lagi.'],
  '40P01': [409, 'Data sedang diubah oleh pengguna lain. Silakan coba lagi.'],
};

export async function buildApp(
  config: Config,
  pool: Pool,
  opts: { logStream?: NodeJS.WritableStream; fileStore?: FileStore } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(opts.logStream ? { stream: opts.logStream } : {}),
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'],
      // Hanya pola rute (bukan URL lengkap) agar query pencarian tidak masuk log.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, route: req.routeOptions?.url }),
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    genReqId: () => randomUUID(),
  });

  app.decorate('pool', pool);
  app.decorate('config', config);
  app.decorate('fileStore', opts.fileStore ?? createFileStore(config.storage));
  app.decorateRequest('auth', null);

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.env === 'production' ? [] : null,
      },
    },
    hsts: config.env === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, { max: config.rateLimitPerMinute, timeWindow: '1 minute' });
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1, fields: 5, parts: 6, fieldSize: 1000 },
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!SAFE_METHODS.has(req.method)) {
      if (req.headers['sec-fetch-site'] === 'cross-site') throw forbidden('Permintaan lintas situs ditolak');
      const origin = req.headers.origin;
      if (origin && !config.appOrigins.includes(origin)) throw forbidden('Asal permintaan tidak diizinkan');
    }
  });

  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    if (NO_SESSION_ROUTES.has(req.routeOptions?.url ?? '')) return;
    req.auth = await resolveAuth(app, req);
    if (!SAFE_METHODS.has(req.method)) checkCsrf(req);
  });

  app.addHook('onResponse', async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      req.log.info({ route: req.routeOptions?.url, method: req.method, status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'request');
    }
    const ctx = req.auth;
    if (ctx?.mode === 'support' && ctx.support && req.url.startsWith('/api/')) {
      // Setiap permintaan dalam mode dukungan teknis tercatat di audit organisasi tujuan.
      try {
        await withTx(pool, { settings: { 'app.mode': 'platform', 'app.user_id': ctx.userId } }, (db) =>
          writeAudit(db, req, { orgId: ctx.orgId, userId: ctx.userId, supportGrantId: ctx.support!.grantId }, {
            action: 'dukungan.akses',
            meta: { metode: req.method, rute: req.routeOptions?.url ?? null, status: reply.statusCode },
          }),
        );
      } catch (err) {
        req.log.error({ err: { message: (err as Error).message } }, 'gagal mencatat audit mode dukungan');
      }
    }
  });

  app.setErrorHandler((err: FastifyError & { constraint?: string; table?: string }, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const pg = typeof err.code === 'string' ? PG_ERRORS[err.code] : undefined;
    if (pg) {
      req.log.warn({ pgCode: err.code, constraint: err.constraint, table: err.table, route: req.routeOptions?.url }, 'database menolak permintaan');
      return reply.status(pg[0]).send({ error: { code: 'db_rejected', message: pg[1] } });
    }
    if (err.statusCode === 429) {
      return reply.status(429).send({ error: { code: 'rate_limited', message: 'Terlalu banyak permintaan. Coba lagi sebentar lagi.' } });
    }
    if (err.statusCode === 413 || err.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send({ error: { code: 'too_large', message: 'Ukuran data atau berkas melebihi batas' } });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: 'bad_request', message: 'Permintaan tidak valid' } });
    }
    // Hanya pesan & stack; tanpa body permintaan maupun detail database.
    req.log.error({ err: { message: err.message, stack: err.stack, code: err.code } }, 'kesalahan server');
    return reply.status(500).send({ error: { code: 'internal', message: 'Terjadi kesalahan pada server. Silakan coba lagi.' } });
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(orgRoutes);
      await api.register(staffRoutes);
      await api.register(patientRoutes);
      await api.register(appointmentRoutes);
      await api.register(noteRoutes);
      await api.register(packageRoutes);
      await api.register(financeRoutes);
      await api.register(compensationRoutes);
      await api.register(reportRoutes);
      await api.register(dashboardRoutes);
      await api.register(documentRoutes);
      await api.register(auditLogRoutes);
      await api.register(supportRoutes);
      await api.register(programRoutes);
      await api.register(invoiceRoutes);
      await api.register(refundRoutes);
      await api.register(reconciliationRoutes);
      await api.register(reminderRoutes);
      await api.register(privacyRoutes);
      await api.register(whatsappRoutes);
      // ?db=1 juga memeriksa koneksi database (untuk pemantauan uptime).
      api.get('/health', async (req) => {
        if ((req.query as Record<string, string>).db === '1') await pool.query('SELECT 1');
        return { ok: true };
      });
    },
    { prefix: '/api' },
  );

  const hasWeb = existsSync(config.webDistDir);
  if (hasWeb) {
    // wildcard:false = hanya file yang ada saat start yang dilayani; setelah build baru, server di-restart.
    await app.register(fastifyStatic, {
      root: config.webDistDir,
      wildcard: false,
      index: false,
      setHeaders: (reply, filePath) => {
        // Nama aset Vite mengandung hash konten, aman di-cache lama.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
  }
  app.setNotFoundHandler((req, reply) => {
    // Fallback SPA hanya untuk navigasi halaman (tanpa ekstensi berkas); aset yang tidak ada tetap 404.
    const pathname = req.url.split('?')[0];
    if (!pathname.startsWith('/api/') && hasWeb && req.method === 'GET' && !path.extname(pathname)) {
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.status(404).send({ error: { code: 'not_found', message: 'Tidak ditemukan' } });
  });

  return app;
}
