import { normalizePhone } from '../routes/reminders.ts';

// Impor data pasien dari lembar kerja berformat bebas.
// 1. Baris judul kolom dicari otomatis (boleh ada judul laporan di atasnya, boleh judul dua tingkat).
// 2. Setiap kolom dicocokkan ke isian pasien dari judulnya; kolom tanpa judul yang dikenal ditebak dari isinya.
// 3. Setiap baris dirapikan (tanggal, L/P, nomor HP) dan diberi status: siap, duplikat, atau dilewati.
// Semua aturan bersifat deterministik dan berjalan di server sendiri; tidak ada data yang dikirim ke layanan luar.

export const IMPORT_FIELDS = {
  fullName: 'Nama lengkap anak',
  nickname: 'Nama panggilan',
  birthDate: 'Tanggal lahir',
  birthPlace: 'Tempat lahir',
  sex: 'Jenis kelamin',
  registeredOn: 'Tanggal pendaftaran',
  status: 'Status pasien',
  address: 'Alamat',
  notes: 'Catatan administrasi',
  complaint: 'Keluhan awal',
  findings: 'Hasil pemeriksaan / diagnosa',
  programNotes: 'Program terapi',
  guardianName: 'Nama orang tua/wali',
  guardianRelationship: 'Hubungan wali',
  guardianPhone: 'No. HP/WA orang tua/wali',
  guardianEmail: 'Email orang tua/wali',
  motherName: 'Nama ibu',
  motherPhone: 'No. HP/WA ibu',
  fatherName: 'Nama ayah',
  fatherPhone: 'No. HP/WA ayah',
} as const;
export type ImportField = keyof typeof IMPORT_FIELDS;
export const FIELD_KEYS = Object.keys(IMPORT_FIELDS) as ImportField[];
// Isian yang boleh diisi lebih dari satu kolom (isinya digabung).
export const MULTI_FIELDS = new Set<ImportField>(['notes']);
// Data pemeriksaan awal (tabel patient_intakes): hanya untuk pengguna dengan hak patient.intake.
export const INTAKE_FIELDS = new Set<ImportField>(['complaint', 'findings', 'programNotes']);
export const fieldGroup = (f: ImportField) => (INTAKE_FIELDS.has(f) ? 'pemeriksaan' : /^(guardian|mother|father)/.test(f) ? 'wali' : 'anak');

export const MAX_IMPORT_ROWS = 2000;

// ---------------------------------------------------------------------------
// Pengenalan judul kolom
// ---------------------------------------------------------------------------
const tokens = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

const PHONE = ['hp', 'wa', 'whatsapp', 'telp', 'telepon', 'telpon', 'tlp', 'tlpn', 'telephone', 'phone', 'ponsel', 'handphone', 'kontak', 'contact', 'mobile', 'seluler', 'hape', 'nohp', 'nowa', 'notelp'];
const MOTHER = ['ibu', 'bunda', 'mama', 'mamah', 'mother', 'umi', 'ummi'];
const FATHER = ['ayah', 'bapak', 'papa', 'papah', 'father', 'abah', 'abi'];
const PARENT = ['ortu', 'orangtua', 'wali', 'parent', 'parents', 'guardian', 'penanggung', 'pj'];
const PERSON_DETAIL = ['pekerjaan', 'pendidikan', 'penghasilan', 'pendapatan', 'agama', 'usia', 'umur', 'lahir', 'ttl', 'nik', 'ktp', 'gaji', 'suku', 'tempat', 'tanggal', 'tgl', 'kantor', 'kerja'];
const ADDRESS = ['alamat', 'domisili', 'address', 'tinggal'];
// Kata yang menandakan judul kolom tentang hal lain, bukan nama anak.
const OTHER_ENTITY = ['sekolah', 'terapis', 'dokter', 'guru', 'kelas', 'instansi', 'klinik', 'rs', 'kantor', 'perusahaan', 'pengantar', 'pendaftar', 'admin', 'petugas', 'file', 'paket', 'layanan', 'program', 'terapi', 'kota', 'desa', 'jalan', 'kelurahan', 'kecamatan', 'kabupaten', 'provinsi', 'bank', 'rekening', 'akun', 'user', 'pengguna', 'saudara', 'kakak', 'adik', 'pasangan', 'suami', 'istri', 'dokumen', 'obat', 'cabang', 'unit', 'panggilan', 'kecil'];
// Judul yang jelas judul kolom tetapi tidak diimpor otomatis (dapat dipilih manual sebagai catatan).
const KNOWN_OTHER = ['no', 'nomor', 'nomer', 'urut', 'usia', 'umur', 'sekolah', 'kelas', 'agama', 'pekerjaan', 'pendidikan', 'terapis', 'jadwal', 'hari', 'jam', 'layanan', 'paket', 'biaya', 'tarif', 'nik', 'kk', 'berat', 'tinggi', 'kota', 'kecamatan', 'kelurahan', 'provinsi', 'rujukan', 'dokter', 'sumber', 'tahun', 'bulan', 'tempat', 'kategori', 'jenis', 'kebutuhan', 'hobi', 'alergi', 'riwayat', 'tanggal', 'tgl', 'total', 'jumlah', 'id', 'foto', 'terapi', 'tindakan', 'kondisi'];

const has = (t: string[], words: string[]) => t.some((w) => words.includes(w));
const hasPhrase = (t: string[], a: string, b: string) => t.some((w, i) => w === a && t[i + 1] === b);

// Isian untuk sebuah judul kolom; 'lain' = dikenali sebagai judul kolom tetapi tidak diimpor otomatis.
export function headerField(label: string): ImportField | 'lain' | null {
  const t = tokens(label);
  if (!t.length || t.length > 7) return null;
  const parent = has(t, PARENT) || hasPhrase(t, 'orang', 'tua');

  if (has(t, ['email', 'surel']) || hasPhrase(t, 'e', 'mail')) return 'guardianEmail';
  if (has(t, PHONE)) return has(t, MOTHER) && !has(t, FATHER) ? 'motherPhone' : has(t, FATHER) && !has(t, MOTHER) ? 'fatherPhone' : 'guardianPhone';
  if (has(t, MOTHER) || has(t, FATHER) || parent) {
    if (has(t, ADDRESS)) return 'address';
    if (has(t, ['hubungan', 'relasi', 'sebagai', 'status'])) return parent ? 'guardianRelationship' : 'lain';
    if (has(t, PERSON_DETAIL)) return 'lain';
    if (has(t, MOTHER) && !has(t, FATHER) && !parent) return 'motherName';
    if (has(t, FATHER) && !has(t, MOTHER) && !parent) return 'fatherName';
    return 'guardianName';
  }
  if (has(t, ['hubungan', 'relasi'])) return 'guardianRelationship';
  // Formulir Google: kolom "Timestamp" / "Cap waktu" = waktu pendaftaran.
  if (has(t, ['timestamp']) || hasPhrase(t, 'cap', 'waktu')) return 'registeredOn';
  if (has(t, ['keluhan'])) return 'complaint';
  if (has(t, ['diagnosa', 'diagnosis']) || (has(t, ['hasil']) && has(t, ['pemeriksaan', 'asesmen', 'assesment', 'assessment', 'observasi', 'evaluasi']))) return 'findings';
  if (has(t, ['program']) && !has(t, ['studi'])) return 'programNotes';
  if (has(t, ['lahir', 'kelahiran'])) {
    if (has(t, ['tahun', 'bulan'])) return 'lain';
    if (has(t, ['tempat']) && !has(t, ['tanggal', 'tgl'])) return 'birthPlace';
    return 'birthDate';
  }
  if (has(t, ['ttl', 'dob', 'birth', 'birthday', 'birthdate'])) return 'birthDate';
  if (has(t, ['no', 'nomor', 'nomer', 'kode', 'id']) && has(t, ['pasien', 'induk', 'registrasi', 'pendaftaran', 'anggota', 'klien', 'rm', 'rekam', 'member'])) return 'notes';
  if (has(t, ['daftar', 'pendaftaran', 'terdaftar', 'registrasi', 'register', 'registered', 'bergabung', 'gabung', 'join', 'joined'])) return 'registeredOn';
  if (has(t, ['masuk', 'mulai', 'awal']) && has(t, ['tgl', 'tanggal', 'tanggal', 'date'])) return 'registeredOn';
  if (has(t, ['kelamin', 'jk', 'gender', 'sex']) || ['l p', 'lp', 'p l'].includes(t.join(' '))) return 'sex';
  if (has(t, ['panggilan', 'sapaan', 'nickname', 'panggil']) || (has(t, ['nama']) && has(t, ['kecil']))) return 'nickname';
  if (has(t, ['status', 'keaktifan'])) {
    return has(t, ['bayar', 'pembayaran', 'lunas', 'pernikahan', 'perkawinan', 'ekonomi', 'sosial', 'gizi']) ? 'lain' : 'status';
  }
  if (has(t, ADDRESS)) return has(t, ['sekolah', 'kantor', 'instansi', 'kerja']) ? 'lain' : 'address';
  if (has(t, ['kode']) && has(t, ['pos'])) return 'lain';
  if (has(t, ['catatan', 'keterangan', 'ket', 'notes', 'note', 'memo', 'remark', 'remarks', 'informasi', 'info', 'kode', 'rm'])) return 'notes';
  if (has(t, ['anak']) && has(t, ['ke'])) return 'lain';
  if (has(t, ['nama', 'name', 'nm']) && !has(t, OTHER_ENTITY)) return 'fullName';
  if (t.length <= 2 && has(t, ['anak', 'pasien', 'klien', 'siswa', 'peserta', 'murid', 'child', 'patient', 'client']) && !has(t, OTHER_ENTITY)) return 'fullName';
  if (has(t, KNOWN_OTHER)) return 'lain';
  return null;
}

// ---------------------------------------------------------------------------
// Pengenalan isi sel
// ---------------------------------------------------------------------------
const MONTHS: Record<string, number> = {
  jan: 1, januari: 1, january: 1,
  feb: 2, peb: 2, februari: 2, pebruari: 2, february: 2,
  mar: 3, maret: 3, march: 3,
  apr: 4, april: 4,
  mei: 5, may: 5,
  jun: 6, juni: 6, june: 6,
  jul: 7, juli: 7, july: 7,
  agu: 8, agt: 8, ags: 8, agus: 8, agustus: 8, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oct: 10, oktober: 10, october: 10,
  nov: 11, nop: 11, november: 11, nopember: 11,
  des: 12, dec: 12, desember: 12, december: 12,
};

function ymd(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return date.toISOString().slice(0, 10);
}

function fullYear(s: string): number {
  const n = Number(s);
  if (s.length !== 2) return n;
  return n <= new Date().getUTCFullYear() % 100 ? 2000 + n : 1900 + n;
}

// Tanggal dalam berbagai bentuk: 2019-03-12, 12/03/2019, 12-3-19, 12 Maret 2019, 12-Mar-2019, March 12, 2019.
// Bentuk angka dibaca tanggal/bulan/tahun (kebiasaan Indonesia) kecuali monthFirst.
// loose: tanggal boleh berada di dalam teks lain (mis. "Surakarta, 12 Maret 2019").
export function parseDate(raw: string, opts: { monthFirst?: boolean; loose?: boolean } = {}): string | null {
  return matchDate(raw, opts)?.iso ?? null;
}

// Seperti parseDate, ditambah posisi awal tanggal di teks (untuk memisahkan tempat lahir dari TTL).
function matchDate(raw: string, opts: { monthFirst?: boolean; loose?: boolean } = {}): { iso: string | null; index: number } | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const wrap = (core: string) => new RegExp(opts.loose ? `(?<![\\d])${core}(?![\\d])` : `^${core}(?:[ t]\\d{1,2}[:.]\\d{2}(?:[:.]\\d{2})?)?$`);
  let m = wrap('(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})').exec(s);
  if (m) return { iso: ymd(+m[1], +m[2], +m[3]), index: m.index };
  m = wrap('(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{4}|\\d{2})').exec(s);
  if (m) {
    let [d, mo] = [+m[1], +m[2]];
    if (opts.monthFirst || (d <= 12 && mo > 12)) [d, mo] = [mo, d];
    return { iso: ymd(fullYear(m[3]), mo, d), index: m.index };
  }
  m = wrap('(\\d{1,2})[\\s\\-./]*([a-z]{3,9})\\.?[\\s\\-./,]*(\\d{4}|\\d{2})').exec(s);
  if (m && MONTHS[m[2]]) return { iso: ymd(fullYear(m[3]), MONTHS[m[2]], +m[1]), index: m.index };
  m = wrap('([a-z]{3,9})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})').exec(s);
  if (m && MONTHS[m[1]]) return { iso: ymd(+m[3], MONTHS[m[1]], +m[2]), index: m.index };
  return null;
}

// "Surakarta, 12 Maret 2019" -> "Surakarta". Null bila tidak ada teks tempat sebelum tanggal.
export function placeFromTtl(raw: string): string | null {
  const m = matchDate(raw, { loose: true });
  if (!m || !m.index) return null;
  const place = raw.trim().slice(0, m.index).replace(/[\s,.;:/-]+$/, '').trim();
  return /\p{L}{2}/u.test(place) ? place.slice(0, 100) : null;
}

// Nomor seri tanggal Excel (sel tanggal yang tersimpan sebagai angka biasa, mis. dari CSV).
function excelSerial(raw: string): string | null {
  if (!/^\d{3,5}(?:\.0+)?$/.test(raw.trim())) return null;
  const n = Math.floor(Number(raw));
  if (n < 367 || n > 80_000) return null;
  return new Date(Date.UTC(1899, 11, 30) + n * 86_400_000).toISOString().slice(0, 10);
}

const SEX: Record<string, 'L' | 'P'> = {};
for (const w of ['l', 'lk', 'laki', 'lakilaki', 'lelaki', 'pria', 'cowok', 'cowo', 'putra', 'male', 'm', 'boy', 'man']) SEX[w] = 'L';
for (const w of ['p', 'pr', 'prp', 'perempuan', 'wanita', 'cewek', 'cewe', 'putri', 'female', 'f', 'girl', 'woman', 'w']) SEX[w] = 'P';
export const parseSex = (raw: string) => SEX[raw.toLowerCase().replace(/[^a-z]/g, '')] ?? null;

export function parseStatus(raw: string): 'aktif' | 'nonaktif' | 'selesai' | null {
  const s = raw.toLowerCase();
  if (/selesai|lulus|alumni|tuntas|graduat/.test(s)) return 'selesai';
  if (/non|tidak|tdk|cuti|berhenti|keluar|pindah|pasif|off|inactive/.test(s)) return 'nonaktif';
  if (/aktif|active|^ya$|masih|berjalan|^on$/.test(s)) return 'aktif';
  return null;
}

const NULLISH = new Set(['', '-', '--', '---', '—', '–', '.', '?', 'x', 'n/a', 'na', 'nihil', 'tidak ada', 'tdk ada', 'belum ada', 'kosong', 'null', 'none', '0']);
const clean = (v: string | undefined) => {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  return NULLISH.has(s.toLowerCase()) ? '' : s;
};

type Kind = 'date' | 'phone' | 'email' | 'sex' | 'number' | 'name' | 'text';
function cellKind(v: string): Kind {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'email';
  if (/^\+?[\d][\d\s().\-]{7,}$/.test(v) && normalizePhone(v)) return 'phone';
  if (parseDate(v)) return 'date';
  if (v.length <= 12 && parseSex(v)) return 'sex';
  if (/^-?\d+(?:[.,]\d+)?$/.test(v)) return 'number';
  if (/^\p{L}[\p{L} .'’`-]{1,149}$/u.test(v) && v.split(' ').length <= 6) return 'name';
  return 'text';
}

// ---------------------------------------------------------------------------
// Tata letak lembar: baris judul dan kolom
// ---------------------------------------------------------------------------
function headerCellScore(v: string): number {
  if (!v) return 0;
  const kind = cellKind(v);
  if (kind !== 'name' && kind !== 'text') return -1;
  // Judul laporan ("DATA PASIEN 2025") bukan judul kolom.
  if (/\d{4}/.test(v) || v.split(' ').length > 6) return 0;
  const f = headerField(v);
  if (f === 'lain') return 0.5;
  if (f) return 1;
  return v.split(' ').length <= 4 ? 0.2 : 0;
}

function rowScore(row: string[]) {
  const cells = row.map((c) => clean(c)).filter(Boolean);
  const scores = cells.map(headerCellScore);
  return {
    score: scores.reduce((a, b) => a + b, 0),
    cells: cells.length,
    allKnown: cells.length > 0 && cells.every((c) => headerField(c) !== null),
    noData: scores.every((s) => s >= 0),
  };
}

// Dua baris judul (mis. "Data Ibu" di atas "Nama" dan "No HP"): baris atas mengisi kolom-kolom
// di bawahnya yang kosong pada baris atas (sel gabungan hanya menyimpan nilai di sel pertama).
function isTwoLevel(top: string[], bottom: string[]) {
  const width = Math.max(top.length, bottom.length);
  let topOnly = false;
  let bottomOnly = false;
  for (let i = 0; i < width; i++) {
    const a = clean(top[i]);
    const b = clean(bottom[i]);
    if (a && !b) topOnly = true;
    if (!a && b) bottomOnly = true;
  }
  return topOnly && bottomOnly;
}

function mergeHeader(top: string[], bottom: string[]): string[] {
  const width = Math.max(top.length, bottom.length);
  const out: string[] = [];
  let group = '';
  for (let i = 0; i < width; i++) {
    const a = clean(top[i]);
    const b = clean(bottom[i]);
    if (a) group = a;
    else if (!b) group = '';
    const upper = a || (b ? group : '');
    out.push([upper, b].filter(Boolean).join(' '));
  }
  return out;
}

export interface Layout {
  headerRows: number[]; // indeks baris (0-based) yang menjadi judul kolom
  labels: string[];
  dataStart: number;
}

export function detectLayout(rows: string[][]): Layout {
  const limit = Math.min(rows.length, 20);
  let best = -1;
  let bestScore = 0;
  for (let r = 0; r < limit; r++) {
    const s = rowScore(rows[r] ?? []);
    if (!s.noData) continue;
    const ok = s.score >= 1.5 || (s.score >= 1 && s.allKnown);
    if (ok && s.score > bestScore) {
      best = r;
      bestScore = s.score;
    }
  }
  if (best < 0) {
    const first = rows.findIndex((r) => r.some((c) => clean(c)));
    return { headerRows: [], labels: [], dataStart: Math.max(first, 0) };
  }
  // Baris judul bawah harus seluruhnya judul yang dikenal (agar baris data pertama tidak ikut terbaca
  // sebagai judul); baris kelompok di atas cukup berisi teks pendek tanpa data.
  const subHeader = (row: string[] | undefined) => {
    const s = row ? rowScore(row) : null;
    return Boolean(s && s.allKnown && s.noData);
  };
  const groupHeader = (row: string[] | undefined) => {
    const s = row ? rowScore(row) : null;
    return Boolean(s && s.cells > 0 && s.noData && s.score > 0);
  };
  const header = rows[best];
  if (subHeader(rows[best + 1]) && isTwoLevel(header, rows[best + 1])) {
    return { headerRows: [best, best + 1], labels: mergeHeader(header, rows[best + 1]), dataStart: best + 2 };
  }
  if (best > 0 && groupHeader(rows[best - 1]) && isTwoLevel(rows[best - 1], header)) {
    return { headerRows: [best - 1, best], labels: mergeHeader(rows[best - 1], header), dataStart: best + 1 };
  }
  return { headerRows: [best], labels: header.map((c) => clean(c)), dataStart: best + 1 };
}

export const columnLetter = (i: number): string => {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

export interface ColumnInfo {
  index: number;
  letter: string;
  label: string;
  samples: string[];
  field: ImportField | null;
}

export type Mapping = Map<number, ImportField>;

function dominantKind(values: string[]): Kind | null {
  if (!values.length) return null;
  const counts = new Map<Kind, number>();
  for (const v of values) counts.set(cellKind(v), (counts.get(cellKind(v)) ?? 0) + 1);
  let best: Kind | null = null;
  let n = 0;
  for (const [k, c] of counts) if (c > n) [best, n] = [k, c];
  return n / values.length >= 0.6 ? best : null;
}

export function analyzeColumns(layout: Layout, data: string[][]): { columns: ColumnInfo[]; suggested: Mapping } {
  const width = Math.max(layout.labels.length, ...data.map((r) => r.length), 0);
  const columns: ColumnInfo[] = [];
  const values: string[][] = [];
  for (let i = 0; i < width; i++) {
    const vals = data.map((r) => clean(r[i])).filter(Boolean);
    const label = layout.labels[i] ?? '';
    if (!label && !vals.length) continue;
    columns.push({ index: i, letter: columnLetter(i), label, samples: [...new Set(vals)].slice(0, 3), field: null });
    values.push(vals.slice(0, 200));
  }

  const suggested: Mapping = new Map();
  const taken = new Set<ImportField>();
  const claim = (col: ColumnInfo, field: ImportField) => {
    if (taken.has(field) && !MULTI_FIELDS.has(field)) return false;
    suggested.set(col.index, field);
    col.field = field;
    taken.add(field);
    return true;
  };
  const unknown: number[] = [];
  columns.forEach((col, k) => {
    const f = col.label ? headerField(col.label) : null;
    if (f && f !== 'lain') {
      if (!claim(col, f)) unknown.push(k);
    } else if (!f) unknown.push(k);
  });
  // Kolom yang judulnya tidak dikenal (atau tanpa judul) ditebak dari isinya.
  const byContent: Partial<Record<Kind, ImportField[]>> = {
    date: ['birthDate', 'registeredOn'],
    phone: ['guardianPhone'],
    email: ['guardianEmail'],
    sex: ['sex'],
    name: ['fullName', 'guardianName'],
  };
  for (const k of unknown) {
    const col = columns[k];
    const kind = dominantKind(values[k]);
    const options = kind ? (byContent[kind] ?? []) : [];
    // Dengan judul kolom, kolom berisi nama hanya dipakai bila nama anak belum ditemukan.
    const allowed = kind === 'name' && layout.headerRows.length ? options.slice(0, 1) : options;
    for (const f of allowed) if (claim(col, f)) break;
  }
  return { columns, suggested };
}

// ---------------------------------------------------------------------------
// Perapian baris
// ---------------------------------------------------------------------------
export interface GuardianDraft {
  fullName: string;
  relationship: string;
  phone: string | null;
  email: string | null;
  isPrimary: boolean;
}

export interface PatientDraft {
  fullName: string;
  nickname: string | null;
  birthPlace: string | null;
  birthDate: string | null;
  sex: 'L' | 'P' | null;
  registeredOn: string | null;
  status: 'aktif' | 'nonaktif' | 'selesai';
  address: string | null;
  adminNotes: string | null;
  guardians: GuardianDraft[];
  // Pemeriksaan awal (null bila kosong).
  intake: { complaint: string | null; findings: string | null; programNotes: string | null } | null;
}

export type RowStatus = 'siap' | 'duplikat' | 'dilewati';

export interface RowResult {
  row: number; // nomor baris di lembar kerja (1-based)
  status: RowStatus;
  patient: PatientDraft;
  issues: string[];
}

export interface ExistingPatient {
  patientCode: string;
  fullName: string;
  birthDate: string | null;
}

const nameKey = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function cut(value: string, max: number, label: string, issues: string[]) {
  if (value.length <= max) return value;
  issues.push(`${label} dipotong menjadi ${max} karakter`);
  return value.slice(0, max);
}

function phoneOf(raw: string, label: string, issues: string[]): string | null {
  if (!raw) return null;
  const parts = raw.split(/[\/,;]|\s+(?:atau|dan|or)\s+|&/i).map((p) => p.trim()).filter(Boolean);
  const valid = parts.map((p) => normalizePhone(p)).filter((p): p is string => Boolean(p));
  if (valid.length) {
    if (valid.length > 1) issues.push(`${label}: hanya nomor pertama yang diimpor`);
    return `0${valid[0].slice(2)}`;
  }
  issues.push(`${label} tidak dikenali sebagai nomor HP; disimpan apa adanya`);
  return raw.slice(0, 40);
}

export interface PrepareOptions {
  today: string;
  existing: ExistingPatient[];
}

// Kolom tanggal berformat bulan/tanggal/tahun (mis. hasil Excel berbahasa Inggris) dikenali dari
// adanya nilai seperti 03/25/2019; selain itu dibaca tanggal/bulan/tahun.
function monthFirstColumns(mapping: Mapping, data: string[][]) {
  const out = new Set<number>();
  for (const [col, field] of mapping) {
    if (field !== 'birthDate' && field !== 'registeredOn') continue;
    let dayFirst = 0;
    let monthFirst = 0;
    for (const r of data) {
      const m = /(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](?:\d{4}|\d{2})(?!\d)/.exec(r[col] ?? '');
      if (!m) continue;
      if (+m[1] > 12) dayFirst++;
      else if (+m[2] > 12) monthFirst++;
    }
    if (monthFirst > 0 && dayFirst === 0) out.add(col);
  }
  return out;
}

export function prepareRows(
  layout: Layout,
  data: string[][],
  dataRowNumbers: number[],
  labels: Map<number, string>,
  mapping: Mapping,
  opts: PrepareOptions,
): { rows: RowResult[]; notices: string[] } {
  const notices: string[] = [];
  const cols = (field: ImportField) => [...mapping].filter(([, f]) => f === field).map(([c]) => c);
  const one = (field: ImportField) => cols(field)[0];
  const monthFirst = monthFirstColumns(mapping, data);
  for (const c of monthFirst) notices.push(`Tanggal pada kolom "${labels.get(c)}" dibaca sebagai bulan/tanggal/tahun.`);

  const genericOnlyContact = one('guardianName') === undefined && (one('guardianPhone') !== undefined || one('guardianEmail') !== undefined);
  const parentColumns = ['motherName', 'motherPhone', 'fatherName', 'fatherPhone'].some((f) => one(f as ImportField) !== undefined);
  if (genericOnlyContact && parentColumns) {
    notices.push('Nomor HP/email orang tua yang tidak bernama dipasangkan ke data ibu atau ayah yang belum memiliki nomor.');
  }

  const existing = new Map<string, ExistingPatient[]>();
  for (const p of opts.existing) {
    const k = nameKey(p.fullName);
    existing.set(k, [...(existing.get(k) ?? []), p]);
  }
  const seen = new Map<string, { row: number; birthDate: string | null }[]>();
  const headerKey = layout.headerRows.length && one('fullName') !== undefined ? nameKey(labels.get(one('fullName')!) ?? '') : null;

  const rows: RowResult[] = [];
  data.forEach((raw, i) => {
    const get = (field: ImportField) => {
      const c = one(field);
      return c === undefined ? '' : clean(raw[c]);
    };
    if (![...mapping.keys()].some((c) => clean(raw[c]))) return;
    const issues: string[] = [];
    const rowNo = dataRowNumbers[i];

    const date = (field: 'birthDate' | 'registeredOn', label: string) => {
      const c = one(field);
      const v = get(field);
      if (!v || c === undefined) return null;
      const iso = parseDate(v, { monthFirst: monthFirst.has(c), loose: true }) ?? excelSerial(v);
      if (!iso) {
        issues.push(`${label} "${v.slice(0, 40)}" tidak dikenali; dikosongkan`);
        return null;
      }
      if (iso > opts.today) {
        issues.push(`${label} berada di masa depan; dikosongkan`);
        return null;
      }
      return iso;
    };

    const fullName = get('fullName');
    const notesParts = cols('notes')
      .map((c) => ({ label: labels.get(c) || `Kolom ${columnLetter(c)}`, value: clean(raw[c]) }))
      .filter((p) => p.value);
    const notes = notesParts.length === 1 && cols('notes').length === 1 ? notesParts[0].value : notesParts.map((p) => `${p.label}: ${p.value}`).join('\n');

    const birthDate = date('birthDate', 'Tanggal lahir');
    const registeredOn = date('registeredOn', 'Tanggal pendaftaran');
    const sexRaw = get('sex');
    const sex = sexRaw ? parseSex(sexRaw) : null;
    if (sexRaw && !sex) issues.push(`Jenis kelamin "${sexRaw.slice(0, 20)}" tidak dikenali; dikosongkan`);
    const statusRaw = get('status');
    const status = statusRaw ? parseStatus(statusRaw) : null;
    if (statusRaw && !status) issues.push(`Status "${statusRaw.slice(0, 20)}" tidak dikenali; dianggap aktif`);

    const nickname = get('nickname');
    const address = get('address');
    // Tempat lahir: kolom tersendiri, atau teks sebelum tanggal pada kolom TTL.
    const ttlCol = one('birthDate');
    const birthPlace = get('birthPlace') || (one('birthPlace') === undefined && ttlCol !== undefined ? (placeFromTtl(clean(raw[ttlCol])) ?? '') : '');
    const complaint = get('complaint');
    const findings = get('findings');
    const programNotes = get('programNotes');
    const patient: PatientDraft = {
      fullName: fullName.slice(0, 150),
      nickname: nickname ? cut(nickname, 60, 'Nama panggilan', issues) : null,
      birthPlace: birthPlace ? cut(birthPlace, 100, 'Tempat lahir', issues) : null,
      birthDate,
      sex,
      registeredOn,
      status: status ?? 'aktif',
      address: address ? cut(address, 500, 'Alamat', issues) : null,
      adminNotes: notes ? cut(notes, 2000, 'Catatan', issues) : null,
      guardians: [],
      intake:
        complaint || findings || programNotes
          ? {
              complaint: complaint ? cut(complaint, 5000, 'Keluhan awal', issues) : null,
              findings: findings ? cut(findings, 10000, 'Hasil pemeriksaan', issues) : null,
              programNotes: programNotes ? cut(programNotes, 5000, 'Program terapi', issues) : null,
            }
          : null,
    };
    patient.guardians = buildGuardians(get, fullName, issues);

    let rowStatus: RowStatus = 'siap';
    if (fullName.length < 2 || !/\p{L}/u.test(fullName)) {
      rowStatus = 'dilewati';
      issues.unshift(fullName ? 'Nama anak tidak valid' : 'Nama anak kosong');
    } else if (fullName.length > 150) {
      rowStatus = 'dilewati';
      issues.unshift('Nama anak lebih dari 150 karakter');
    } else if (headerKey && nameKey(fullName) === headerKey) {
      // Judul kolom yang terulang (mis. lembar cetak per halaman).
      return;
    } else {
      const k = nameKey(fullName);
      const sameBirth = (b: string | null) => !b || !patient.birthDate || b === patient.birthDate;
      const inDb = (existing.get(k) ?? []).find((p) => sameBirth(p.birthDate));
      const inFile = (seen.get(k) ?? []).find((p) => sameBirth(p.birthDate));
      if (inDb) {
        rowStatus = 'duplikat';
        issues.unshift(`Sudah terdaftar sebagai ${inDb.patientCode}`);
      } else if (inFile) {
        rowStatus = 'duplikat';
        issues.unshift(`Sama dengan baris ${inFile.row}`);
      }
      seen.set(k, [...(seen.get(k) ?? []), { row: rowNo, birthDate: patient.birthDate }]);
    }
    rows.push({ row: rowNo, status: rowStatus, patient, issues });
  });
  return { rows, notices };
}

function buildGuardians(get: (f: ImportField) => string, childName: string, issues: string[]): GuardianDraft[] {
  const make = (name: string, relationship: string, phone: string, email: string, phoneLabel: string) => ({
    name,
    relationship,
    phone: phoneOf(phone, phoneLabel, issues),
    email: email ? email.slice(0, 200) : null,
  });
  const relRaw = get('guardianRelationship');
  const relationship = relRaw ? relRaw.charAt(0).toUpperCase() + relRaw.slice(1, 40) : 'Orang tua';
  const mother = get('motherName') || get('motherPhone') ? make(get('motherName'), 'Ibu', get('motherPhone'), '', 'No. HP ibu') : null;
  const father = get('fatherName') || get('fatherPhone') ? make(get('fatherName'), 'Ayah', get('fatherPhone'), '', 'No. HP ayah') : null;
  let generic =
    get('guardianName') || get('guardianPhone') || get('guardianEmail')
      ? make(get('guardianName'), relationship.length >= 2 ? relationship : 'Orang tua', get('guardianPhone'), get('guardianEmail'), 'No. HP wali')
      : null;

  // Kontak tanpa nama dipasangkan ke ibu/ayah yang belum punya nomor agar tidak muncul wali tanpa nama.
  if (generic && !generic.name && (mother || father)) {
    const slot = [mother, father].find((g) => g && !g.phone);
    if (generic.phone && slot) {
      slot.phone = generic.phone;
      generic.phone = null;
    }
    const emailSlot = (mother ?? father)!;
    if (generic.email && !emailSlot.email) {
      emailSlot.email = generic.email;
      generic.email = null;
    }
    if (!generic.phone && !generic.email) generic = null;
  }

  const list = [generic, mother, father].filter((g): g is NonNullable<typeof g> => Boolean(g));
  const guardians: GuardianDraft[] = list.map((g) => {
    let fullName = g.name;
    if (fullName.length < 2) {
      fullName = `${g.relationship === 'Orang tua' ? 'Orang tua' : g.relationship} ${childName}`.trim();
      issues.push(`Nama ${g.relationship.toLowerCase()} kosong; diisi "${fullName.slice(0, 60)}"`);
    }
    return { fullName: fullName.slice(0, 150), relationship: g.relationship.slice(0, 40), phone: g.phone, email: g.email, isPrimary: false };
  });
  if (guardians.length) {
    const primary = guardians.find((g) => g.phone && /^0\d{9,14}$/.test(g.phone)) ?? guardians[0];
    primary.isPrimary = true;
  }
  return guardians;
}
