const rupiah = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('id-ID');
const dateLong = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const dateShort = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const weekday = new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

export const formatRupiah = (n: number | null | undefined) => (n === null || n === undefined ? '—' : rupiah.format(n));
export function formatBytes(n: number | null | undefined) {
  if (n === null || n === undefined) return '—';
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
export const formatNumber = (n: number | null | undefined) => (n === null || n === undefined ? '—' : number.format(n));

const asUtcDate = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00Z`);
export const formatDate = (d: string | null | undefined) => (d ? dateLong.format(asUtcDate(d)) : '—');
export const formatDateShort = (d: string | null | undefined) => (d ? dateShort.format(asUtcDate(d)) : '—');
export const formatWeekday = (d: string) => weekday.format(asUtcDate(d));

export function formatDateTime(iso: string | null | undefined, timeZone = 'Asia/Jakarta') {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(iso));
}

// "YYYY-MM-DD" hari ini pada zona waktu organisasi.
export function todayIn(timeZone = 'Asia/Jakarta', offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function addDays(date: string, days: number) {
  const d = asUtcDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function monthRange(date: string) {
  const d = asUtcDate(date);
  const from = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  return { from, to };
}

export function ageLabel(birthDate: string | null | undefined, today: string) {
  if (!birthDate) return '—';
  const b = asUtcDate(birthDate);
  const t = asUtcDate(today);
  let months = (t.getUTCFullYear() - b.getUTCFullYear()) * 12 + (t.getUTCMonth() - b.getUTCMonth());
  if (t.getUTCDate() < b.getUTCDate()) months -= 1;
  if (months < 0) return '—';
  const y = Math.floor(months / 12);
  const m = months % 12;
  return y > 0 ? `${y} th${m ? ` ${m} bln` : ''}` : `${m} bln`;
}

// 62812... -> 0812...
export const formatPhone = (phone: string | null | undefined) => (phone ? `0${phone.slice(2)}` : '—');

export const APPT_STATUS: Record<string, { label: string; tone: string }> = {
  terjadwal: { label: 'Terjadwal', tone: 'info' },
  selesai: { label: 'Selesai', tone: 'ok' },
  tidak_hadir: { label: 'Tidak hadir', tone: 'warn' },
  dibatalkan: { label: 'Dibatalkan', tone: 'danger' },
  dijadwal_ulang: { label: 'Dijadwal ulang', tone: '' },
};

export const BILLING: Record<string, string> = { paket: 'Paket', per_sesi: 'Per sesi', tanpa_biaya: 'Tanpa biaya' };
export const METHOD: Record<string, string> = { tunai: 'Tunai', transfer: 'Transfer bank', qris: 'QRIS (dicatat manual)' };
export const NOTE_TYPE: Record<string, string> = { sesi: 'Catatan sesi', asesmen: 'Asesmen', evaluasi: 'Evaluasi', lainnya: 'Lainnya' };
export const PATIENT_STATUS: Record<string, { label: string; tone: string }> = {
  aktif: { label: 'Aktif', tone: 'ok' },
  nonaktif: { label: 'Nonaktif', tone: '' },
  selesai: { label: 'Selesai program', tone: 'info' },
};
export const PACKAGE_STATUS: Record<string, { label: string; tone: string }> = {
  aktif: { label: 'Aktif', tone: 'ok' },
  selesai: { label: 'Habis', tone: '' },
  dibatalkan: { label: 'Dibatalkan', tone: 'danger' },
};
export const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin / Koordinator' },
  { value: 'terapis', label: 'Terapis' },
  { value: 'keuangan', label: 'Keuangan / Kasir' },
];
