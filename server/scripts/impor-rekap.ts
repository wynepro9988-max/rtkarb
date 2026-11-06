// Impor rekap absensi lama dari file JSON (lihat server/src/lib/impor-rekap.ts untuk formatnya).
//   node --env-file=.env server/scripts/impor-rekap.ts <file.json>            -> uji coba, tidak menyimpan
//   node --env-file=.env server/scripts/impor-rekap.ts <file.json> --commit   -> menyimpan
// File masukan berisi data pasien nyata: simpan di luar repositori dan hapus setelah dipakai.
// Ringkasan yang dicetak hanya berisi penanda baris & No. RM, tanpa isi catatan klinis.
import { readFileSync } from 'node:fs';
import { assertSafeAppRole, createPool } from '../src/db.ts';
import { importRekap, type RekapInput } from '../src/lib/impor-rekap.ts';

const [file, flag] = process.argv.slice(2);
if (!file || (flag && flag !== '--commit')) {
  console.error('Pemakaian: impor-rekap.ts <file.json> [--commit]');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL belum diisi');
const pool = createPool(url, { max: 1 });
try {
  await assertSafeAppRole(pool);
  const input = JSON.parse(readFileSync(file, 'utf8')) as RekapInput;
  const r = await importRekap(pool, input, { commit: flag === '--commit' });
  const count = (k: string) => r.sessions.filter((s) => s.result === k).length;
  console.log(r.committed ? 'DISIMPAN' : 'UJI COBA (tidak ada yang disimpan)');
  console.log(`pasien baru: ${r.patients.filter((p) => !p.existed).length}, sudah ada: ${r.patients.filter((p) => p.existed).length}`);
  for (const p of r.patients) console.log(`  ${p.key} -> ${p.patientCode}${p.existed ? ' (sudah ada)' : ''}`);
  console.log(`sesi dimasukkan: ${count('dimasukkan')}, sudah ada: ${count('sudah ada')}, dengan catatan: ${r.sessions.filter((s) => s.noteWritten).length}`);
  console.log(`honor sesi: ${r.sessions.reduce((n, s) => n + (s.compensation ?? 0), 0)}`);
  for (const a of r.allowances) console.log(`  tunjangan ${a.memberId}: ${a.result}`);
} finally {
  await pool.end();
}
