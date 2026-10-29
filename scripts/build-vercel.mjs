// Menyusun deployment Vercel dengan Build Output API v3 (https://vercel.com/docs/build-output-api):
//   .vercel/output/static/                 -> hasil build web (web/dist)
//   .vercel/output/functions/api.func/     -> API Fastify dibundel esbuild (satu Function)
//   .vercel/output/config.json             -> header keamanan + routing
// Dijalankan oleh `npm run build:vercel` (setelah `npm run build`).
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, '.vercel/output');
const webDist = path.join(root, 'web/dist');
if (!existsSync(path.join(webDist, 'index.html'))) {
  console.error('web/dist belum ada. Jalankan `npm run build` terlebih dahulu.');
  process.exit(1);
}

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, 'static'), { recursive: true });
await cp(webDist, path.join(out, 'static'), { recursive: true });

const fnDir = path.join(out, 'functions/api.func');
await mkdir(fnDir, { recursive: true });
await build({
  entryPoints: [path.join(root, 'server/src/vercel.ts')],
  outfile: path.join(fnDir, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Dependensi CommonJS di dalam bundle ESM membutuhkan `require`.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  // Driver native opsional milik `pg`; tidak dipakai.
  external: ['pg-native'],
  legalComments: 'none',
  logLevel: 'warning',
});
// Logo resmi untuk kop PDF (dibaca server/src/lib/pdf.ts di samping bundle).
await cp(path.join(root, 'brand/logo-rumah-bintang.jpg'), path.join(fnDir, 'logo-rumah-bintang.jpg'));
// Function wajib satu region dengan database: setiap permintaan beberapa kali bolak-balik ke
// Postgres. Proyek Supabase saat ini di Mumbai (ap-south-1) -> bom1. Tanpa ini Vercel memakai iad1.
const functionRegion = process.env.FUNCTION_REGION?.trim() || 'bom1';
await writeFile(
  path.join(fnDir, '.vc-config.json'),
  JSON.stringify(
    { runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', maxDuration: 30, shouldAddHelpers: false, regions: [functionRegion] },
    null,
    2,
  ),
);

// Header yang sama dengan @fastify/helmet di server (lihat server/src/app.ts), untuk berkas statis.
const securityHeaders = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Robots-Tag': 'noindex, nofollow',
};

// Cron pengingat WhatsApp otomatis (opsional). Vercel memanggil GET /api/cron/reminders dengan
// Authorization: Bearer CRON_SECRET. Jadwal per 10 menit membutuhkan paket Pro; paket Hobby hanya
// mengizinkan sekali sehari (deploy gagal bila lebih sering) -> kosongkan CRON_SCHEDULE dan pakai
// penjadwal eksternal. Lihat docs/07-supabase-vercel.md.
const cronSchedule = process.env.CRON_SCHEDULE?.trim();

await writeFile(
  path.join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      ...(cronSchedule ? { crons: [{ path: '/api/cron/reminders', schedule: cronSchedule }] } : {}),
      routes: [
        // Header keamanan untuk semua yang bukan API (API memasang headernya sendiri).
        { src: '^/(?!api/).*$', headers: securityHeaders, continue: true },
        // Aset Vite ber-hash konten: aman di-cache lama.
        { src: '^/assets/(.*)$', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' }, continue: true },
        { handle: 'filesystem' },
        { src: '^/api(/.*)?$', dest: '/api' },
        // Navigasi halaman (tanpa ekstensi berkas) -> aplikasi web. Aset yang tidak ada tetap 404.
        { src: '^/[^.]*$', dest: '/index.html', headers: { 'Cache-Control': 'no-cache' } },
      ],
    },
    null,
    2,
  ),
);
console.log(`Build Output Vercel siap di .vercel/output, region function ${functionRegion}${cronSchedule ? ` (cron pengingat: ${cronSchedule})` : ' (tanpa cron)'}`);
