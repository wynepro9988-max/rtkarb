import { inflateRawSync } from 'node:zlib';
import { badRequest, HttpError } from '../errors.ts';

// Pembaca lembar kerja minimal (XLSX dan CSV) tanpa dependensi pihak ketiga.
// Hasilnya grid teks: sel bertanggal ditulis YYYY-MM-DD, angka tanpa pemisah ribuan.
// Formula tidak dievaluasi; yang dipakai adalah nilai tersimpan dari Excel.

export interface SheetGrid {
  name: string;
  rows: string[][];
}

const MAX_ROWS = 5000;
const MAX_COLS = 100;
// Batas hasil dekompresi per berkas di dalam ZIP (melindungi dari "zip bomb").
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;

const unreadable = () => badRequest('Berkas tidak dapat dibaca. Gunakan berkas Excel (.xlsx) atau CSV.');

export function readSpreadsheet(buf: Buffer): SheetGrid[] {
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return readXlsx(buf);
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') {
    throw badRequest(
      'Berkas PDF tidak dapat diimpor karena isi tabelnya tidak terbaca rapi. Bila datanya dari Google Form/Google Sheets, buka spreadsheet-nya lalu pilih File → Download → Microsoft Excel (.xlsx), kemudian impor berkas itu.',
    );
  }
  if (buf.length >= 8 && buf.readUInt32LE(0) === 0xe011cfd0 && buf.readUInt32LE(4) === 0xe11ab1a1) {
    // Format OLE: Excel 97–2003 (.xls) atau berkas Excel yang dikunci kata sandi.
    throw badRequest('Berkas .xls (Excel 97–2003) atau berkas berkata sandi belum didukung. Buka di Excel, lalu simpan sebagai .xlsx tanpa kata sandi.');
  }
  return [{ name: 'CSV', rows: readCsv(decodeText(buf)) }];
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------
function unzip(buf: Buffer): Map<string, () => Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw unreadable();
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, () => Buffer>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw unreadable();
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).toLowerCase();
    p += 46 + nameLen + extraLen + commentLen;
    entries.set(name, () => {
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw unreadable();
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method !== 8) throw unreadable();
      try {
        return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
      } catch (err) {
        if (err instanceof RangeError) throw new HttpError(413, 'Isi berkas terlalu besar untuk diimpor', 'too_large');
        throw unreadable();
      }
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------
// Prefiks namespace (mis. <x:row>) dibuang agar pola di bawah cukup satu bentuk.
const stripNs = (xml: string) => xml.replace(/<(\/?)[A-Za-z_][\w.-]*:/g, '<$1');
const attr = (attrs: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];

function decodeXml(s: string): string {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
      const k = e.toLowerCase();
      if (k === 'amp') return '&';
      if (k === 'lt') return '<';
      if (k === 'gt') return '>';
      if (k === 'quot') return '"';
      if (k === 'apos') return "'";
      const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

const textOf = (xml: string) => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]);

function isDateFormat(id: number, code: string | undefined): boolean {
  if (BUILTIN_DATE_FORMATS.has(id)) return true;
  if (!code) return false;
  const cleaned = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  return /[dy]/i.test(cleaned) || (/m/i.test(cleaned) && !/[hs]/i.test(cleaned));
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return Math.abs(n) < 1e21 ? n.toFixed(0) : String(n);
  return String(Number(n.toPrecision(15)));
}

function serialToIso(serial: number, date1904: boolean): string {
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return new Date(base + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
}

function readXlsx(buf: Buffer): SheetGrid[] {
  const zip = unzip(buf);
  const text = (name: string) => {
    const get = zip.get(name.toLowerCase());
    return get ? stripNs(get().toString('utf8')) : null;
  };
  const workbook = text('xl/workbook.xml');
  if (workbook === null) {
    if (zip.has('content.xml')) throw badRequest('Berkas OpenDocument (.ods) belum didukung. Simpan sebagai .xlsx atau CSV.');
    throw unreadable();
  }
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(workbook);

  const rels = new Map<string, string>();
  for (const m of (text('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) rels.set(id, target);
  }
  const resolve = (target: string) => {
    const parts = (target.startsWith('/') ? target.slice(1) : `xl/${target}`).split('/');
    const out: string[] = [];
    for (const part of parts) {
      if (part === '..') out.pop();
      else if (part && part !== '.') out.push(part);
    }
    return out.join('/');
  };

  const sharedXml = text('xl/sharedStrings.xml') ?? '';
  const shared = [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map((m) =>
    textOf((m[1] ?? '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')),
  );

  const stylesXml = text('xl/styles.xml') ?? '';
  const customFormats = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt\b([^>]*?)\/?>/g)) {
    customFormats.set(Number(attr(m[1], 'numFmtId')), decodeXml(attr(m[1], 'formatCode') ?? ''));
  }
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml)?.[1] ?? '';
  const dateStyle = [...cellXfs.matchAll(/<xf\b([^>]*?)\/?>/g)].map((m) => {
    const id = Number(attr(m[1], 'numFmtId') ?? 0);
    return isDateFormat(id, customFormats.get(id));
  });

  const sheets: SheetGrid[] = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const state = attr(m[1], 'state');
    if (state === 'hidden' || state === 'veryHidden') continue;
    const relId = /\s[\w]+:id="([^"]*)"/.exec(m[1])?.[1];
    const target = relId ? rels.get(relId) : undefined;
    const xml = target ? text(resolve(target)) : null;
    if (xml === null) continue;
    sheets.push({ name: decodeXml(attr(m[1], 'name') ?? `Sheet ${sheets.length + 1}`), rows: sheetRows(xml, shared, dateStyle, date1904) });
  }
  return sheets;
}

function sheetRows(xml: string, shared: string[], dateStyle: boolean[], date1904: boolean): string[][] {
  const data = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)?.[1] ?? '';
  const rows: string[][] = [];
  let nextRow = 0;
  for (const rm of data.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rAttr = attr(rm[1], 'r');
    const r = rAttr ? Number(rAttr) - 1 : nextRow;
    nextRow = r + 1;
    if (!Number.isInteger(r) || r < 0) continue;
    if (r >= MAX_ROWS) break;
    const cells: string[] = [];
    let nextCol = 0;
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cm[1], 'r');
      const c = ref ? colIndex(ref) : nextCol;
      nextCol = c + 1;
      if (c < 0 || c >= MAX_COLS) continue;
      cells[c] = cellValue(cm[1], cm[2] ?? '', shared, dateStyle, date1904);
    }
    rows[r] = Array.from(cells, (v) => v ?? '');
  }
  return Array.from(rows, (r) => r ?? []);
}

function cellValue(attrs: string, inner: string, shared: string[], dateStyle: boolean[], date1904: boolean): string {
  const type = attr(attrs, 't');
  if (type === 'inlineStr') return textOf(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
  if (raw === undefined) return '';
  const v = decodeXml(raw);
  if (type === 's') return shared[Number(v)] ?? '';
  if (type === 'str') return v;
  if (type === 'b') return v === '1' ? 'TRUE' : 'FALSE';
  if (type === 'e') return '';
  if (type === 'd') return v.slice(0, 10);
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (dateStyle[Number(attr(attrs, 's') ?? 0)] && n >= 1) return serialToIso(n, date1904);
  return formatNumber(n);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  const body = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  if (body.includes(0)) throw unreadable();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    // CSV dari Excel Windows lama umumnya memakai Windows-1252.
    return new TextDecoder('windows-1252').decode(body);
  }
}

function parseCsv(text: string, delimiter: string, limit = MAX_ROWS): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  while (i < text.length && rows.length < limit) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      row.push(cell);
      rows.push(row.slice(0, MAX_COLS));
      row = [];
      cell = '';
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else cell += ch;
    i++;
  }
  if (rows.length < limit && (cell !== '' || row.length)) {
    row.push(cell);
    rows.push(row.slice(0, MAX_COLS));
  }
  return rows;
}

// Pemisah dipilih dari baris-baris awal: yang paling sering menghasilkan jumlah kolom yang sama (>1).
// Excel berbahasa Indonesia menyimpan CSV dengan titik koma.
function readCsv(text: string): string[][] {
  let best = { delimiter: ',', score: 0, width: 1 };
  for (const delimiter of [';', ',', '\t', '|']) {
    const sample = parseCsv(text, delimiter, 30).filter((r) => r.some((c) => c.trim()));
    const counts = new Map<number, number>();
    for (const r of sample) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
    let width = 1;
    let score = 0;
    for (const [w, n] of counts) if (w > 1 && (n > score || (n === score && w > width))) [width, score] = [w, n];
    if (score > best.score || (score === best.score && score > 0 && width > best.width)) best = { delimiter, score, width };
  }
  return parseCsv(text, best.delimiter);
}
