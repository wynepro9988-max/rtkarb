import { existsSync } from 'node:fs';
import path from 'node:path';

const envFile = path.resolve(import.meta.dirname, '../../.env');
if (!process.env.TEST_DATABASE_URL && existsSync(envFile)) process.loadEnvFile(envFile);

export function testUrls() {
  const appUrl = process.env.TEST_DATABASE_URL;
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  if (!appUrl || !adminUrl) throw new Error('TEST_DATABASE_URL dan TEST_DATABASE_ADMIN_URL wajib diisi (jalankan npm run db:init)');
  for (const u of [appUrl, adminUrl]) {
    const parsed = new URL(u);
    // Pengaman: database uji dibuat ulang setiap run, jadi hanya *_test di localhost yang diizinkan.
    if (!parsed.pathname.endsWith('_test') || !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
      throw new Error(`Menolak memakai ${parsed.hostname}${parsed.pathname} sebagai database uji`);
    }
  }
  return { appUrl, adminUrl };
}
