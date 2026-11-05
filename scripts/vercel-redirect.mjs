// Vercel dinonaktifkan sejak 5 Nov 2026: aplikasi pindah ke VPS (https://rumahbintang.my.id).
// Build Vercel hanya menghasilkan pengalihan permanen untuk semua alamat lama; tidak ada API
// dan tidak ada koneksi ke database. Prosedur lama tetap di scripts/build-vercel.mjs.
import { mkdir, rm, writeFile } from 'node:fs/promises';

const TARGET = 'https://rumahbintang.my.id';
const out = '.vercel/output';
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await writeFile(
  `${out}/config.json`,
  JSON.stringify({ version: 3, routes: [{ src: '/(.*)', status: 308, headers: { Location: `${TARGET}/$1` } }] }, null, 2),
);
console.log(`Build Output Vercel: semua alamat dialihkan ke ${TARGET}`);
