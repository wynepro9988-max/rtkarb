import path from 'node:path';

export interface StorageConfig {
  driver: 'local' | 'supabase';
  // driver=local
  uploadDir: string;
  // driver=supabase (Supabase Storage, bucket privat)
  supabaseUrl: string | null;
  supabaseKey: string | null;
  bucket: string;
}

export interface WhatsAppConfig {
  // Kunci AES-256 (32 byte, base64) untuk mengenkripsi token Fonnte di database.
  // Kosong -> fitur WhatsApp otomatis nonaktif.
  encryptionKey: Buffer | null;
  // Rahasia untuk endpoint cron (Vercel mengirimkannya sebagai Authorization: Bearer).
  cronSecret: string | null;
  fonnteApiUrl: string;
  timeoutMs: number;
  // Jarak antarpesan (detik) yang dijadwalkan di Fonnte, agar tidak terkirim beruntun.
  sendGapSeconds: number;
}

export interface Config {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  dbPoolMax: number;
  appOrigins: string[];
  publicBaseUrl: string;
  cookieSecure: boolean;
  trustProxy: boolean;
  sessionIdleMinutes: number;
  sessionMaxDays: number;
  uploadDir: string;
  maxUploadBytes: number;
  storage: StorageConfig;
  // Batas kapasitas (disesuaikan dengan paket Supabase Free, lihat docs/07-supabase-vercel.md).
  orgStorageQuotaBytes: number;
  dbSizeLimitBytes: number;
  storageLimitBytes: number;
  webDistDir: string;
  logLevel: string;
  rateLimitPerMinute: number;
  authRateLimitPerMinute: number;
  whatsapp: WhatsAppConfig;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Variabel lingkungan ${name} wajib diisi`);
  return value;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Nilai angka tidak valid: ${value}`);
  return n;
}

const MB = 1024 * 1024;

function encryptionKey(value: string | undefined): Buffer | null {
  if (!value) return null;
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY harus 32 byte dalam base64 (openssl rand -base64 32)');
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = (env.NODE_ENV ?? 'development') as Config['env'];
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error(`NODE_ENV tidak dikenal: ${nodeEnv}`);
  }
  const isProd = nodeEnv === 'production';
  const appOrigins = (env.APP_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);

  const driver = (env.STORAGE_DRIVER ?? 'local') as StorageConfig['driver'];
  if (!['local', 'supabase'].includes(driver)) throw new Error(`STORAGE_DRIVER tidak dikenal: ${driver}`);
  const uploadDir = path.resolve(env.UPLOAD_DIR ?? '.data/uploads');

  const config: Config = {
    env: nodeEnv,
    host: env.HOST ?? '127.0.0.1',
    port: int(env.PORT, 3000),
    databaseUrl: required(env, 'DATABASE_URL'),
    // Serverless (Vercel): kecil, karena tiap instance punya pool sendiri.
    dbPoolMax: int(env.DB_POOL_MAX, 10),
    appOrigins,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? appOrigins[0]).replace(/\/$/, ''),
    cookieSecure: bool(env.COOKIE_SECURE, isProd),
    trustProxy: bool(env.TRUST_PROXY, isProd),
    sessionIdleMinutes: int(env.SESSION_IDLE_MINUTES, 720),
    sessionMaxDays: int(env.SESSION_MAX_DAYS, 14),
    uploadDir,
    // 4 MB: di bawah batas body Vercel Functions (4,5 MB) dan batas unggah Supabase Free (50 MB).
    maxUploadBytes: int(env.MAX_UPLOAD_MB, 4) * MB,
    storage: {
      driver,
      uploadDir,
      supabaseUrl: env.SUPABASE_URL?.replace(/\/$/, '') ?? null,
      supabaseKey: env.SUPABASE_SECRET_KEY ?? null,
      bucket: env.SUPABASE_STORAGE_BUCKET ?? 'dokumen-pasien',
    },
    // Dua organisasi x 450 MB = 900 MB, di bawah 1 GB penyimpanan Supabase Free.
    orgStorageQuotaBytes: int(env.ORG_STORAGE_QUOTA_MB, 450) * MB,
    dbSizeLimitBytes: int(env.DB_SIZE_LIMIT_MB, 500) * MB,
    storageLimitBytes: int(env.STORAGE_LIMIT_MB, 1024) * MB,
    webDistDir: path.resolve(import.meta.dirname, '../../web/dist'),
    logLevel: env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
    rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 300),
    authRateLimitPerMinute: int(env.AUTH_RATE_LIMIT_PER_MINUTE, 10),
    whatsapp: {
      encryptionKey: encryptionKey(env.APP_ENCRYPTION_KEY),
      cronSecret: env.CRON_SECRET || null,
      fonnteApiUrl: (env.FONNTE_API_URL ?? 'https://api.fonnte.com').replace(/\/$/, ''),
      timeoutMs: int(env.FONNTE_TIMEOUT_MS, 10_000),
      sendGapSeconds: env.WA_SEND_GAP_SECONDS === '0' ? 0 : int(env.WA_SEND_GAP_SECONDS, 10),
    },
  };

  if (driver === 'supabase' && (!config.storage.supabaseUrl || !config.storage.supabaseKey)) {
    throw new Error('STORAGE_DRIVER=supabase membutuhkan SUPABASE_URL dan SUPABASE_SECRET_KEY');
  }
  if (isProd) {
    if (!config.cookieSecure) throw new Error('COOKIE_SECURE wajib true di produksi');
    if (!config.publicBaseUrl.startsWith('https://')) throw new Error('PUBLIC_BASE_URL wajib https di produksi');
    if (config.whatsapp.cronSecret && config.whatsapp.cronSecret.length < 32) throw new Error('CRON_SECRET minimal 32 karakter');
  }
  return config;
}
