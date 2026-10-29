import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

// Penulis PDF minimal (PDF 1.4) tanpa dependensi: font standar Helvetica (WinAnsi), teks,
// garis, kotak, tabel dengan pembungkusan teks, dan gambar JPEG (logo). Cukup untuk
// kuitansi, invoice, laporan, dan ekspor data pasien.

// Lebar glyph Helvetica / Helvetica-Bold (AFM standar, per 1000 em) untuk karakter 32..126.
const W_REG = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
  556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889,
  611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

// Teks Unicode -> byte WinAnsi (Latin-1 untuk 160..255), karakter lain diganti padanan ASCII.
function toWinAnsi(input: string): string {
  return input
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
    .replace(/[  ]/g, ' ')
    .replace(/[\r\t]/g, ' ')
    .replace(/[^\n -~¡-ÿ]/g, '?');
}

function charWidth(code: number, bold: boolean): number {
  if (code >= 32 && code <= 126) return (bold ? W_BOLD : W_REG)[code - 32];
  return 556;
}

export function textWidth(text: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of toWinAnsi(text)) w += charWidth(ch.charCodeAt(0), bold);
  return (w / 1000) * size;
}

const escapePdf = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function wrapText(text: string, maxWidth: number, size: number, bold = false): string[] {
  const lines: string[] = [];
  for (const paragraph of toWinAnsi(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/ +/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, bold) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      // Kata yang lebih panjang dari baris dipotong paksa.
      let rest = word;
      while (textWidth(rest, size, bold) > maxWidth && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && textWidth(rest.slice(0, cut), size, bold) > maxWidth) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
  }
  return lines;
}

interface Jpeg {
  data: Buffer;
  width: number;
  height: number;
  colorSpace: string;
}

function parseJpeg(data: Buffer): Jpeg | null {
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;
  let i = 2;
  while (i < data.length - 9) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1];
    const len = data.readUInt16BE(i + 2);
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const comps = data[i + 9];
      return {
        data,
        height: data.readUInt16BE(i + 5),
        width: data.readUInt16BE(i + 7),
        colorSpace: comps === 1 ? '/DeviceGray' : comps === 4 ? '/DeviceCMYK' : '/DeviceRGB',
      };
    }
    i += 2 + len;
  }
  return null;
}

// Logo resmi: dari brand/ saat berjalan dari source, atau disalin di samping bundle Vercel.
let logoCache: Buffer | null | undefined;
export function loadLogo(): Buffer | null {
  if (logoCache !== undefined) return logoCache;
  const candidates = [
    path.resolve(import.meta.dirname, '../../../brand/logo-rumah-bintang.jpg'),
    path.resolve(import.meta.dirname, 'logo-rumah-bintang.jpg'),
  ];
  const found = candidates.find((p) => existsSync(p));
  logoCache = found ? readFileSync(found) : null;
  return logoCache;
}

type Rgb = [number, number, number];
const NAVY: Rgb = [0.173, 0.216, 0.553];
const INK: Rgb = [0.12, 0.14, 0.19];
const MUTED: Rgb = [0.35, 0.38, 0.44];
const LINE: Rgb = [0.85, 0.84, 0.8];

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;

export interface PdfHeader {
  orgName: string;
  orgLines?: string[];
  title: string;
  subtitle?: string;
  confidential?: boolean;
  logo?: Buffer | null;
}

export interface PdfColumn {
  header: string;
  width: number; // pecahan lebar konten (jumlah semua kolom = 1)
  align?: 'left' | 'right';
}

export class PdfReport {
  private pages: string[] = [];
  private ops: string[] = [];
  private y = 0;
  private readonly header: PdfHeader;
  private readonly logo: Jpeg | null;

  constructor(header: PdfHeader) {
    this.header = header;
    this.logo = header.logo ? parseJpeg(header.logo) : null;
    this.newPage(true);
  }

  // ---------- primitif ----------
  private color(c: Rgb, stroke = false) {
    this.ops.push(`${c.map((v) => v.toFixed(3)).join(' ')} ${stroke ? 'RG' : 'rg'}`);
  }

  private textAt(x: number, y: number, text: string, size: number, bold = false, c: Rgb = INK) {
    this.color(c);
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escapePdf(toWinAnsi(text))}) Tj ET`);
  }

  private line(x1: number, y1: number, x2: number, y2: number, c: Rgb = LINE, width = 0.7) {
    this.color(c, true);
    this.ops.push(`${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }

  private rect(x: number, y: number, w: number, h: number, c: Rgb) {
    this.color(c);
    this.ops.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }

  private newPage(first = false) {
    if (!first) this.pages.push(this.ops.join('\n'));
    this.ops = [];
    let top = PAGE_H - MARGIN;
    if (first) {
      const logoSize = 64;
      if (this.logo) {
        this.ops.push(`q ${logoSize} 0 0 ${logoSize} ${MARGIN} ${(top - logoSize).toFixed(2)} cm /Im1 Do Q`);
      }
      const x = this.logo ? MARGIN + logoSize + 14 : MARGIN;
      this.textAt(x, top - 16, this.header.orgName, 13, true, NAVY);
      let ly = top - 30;
      for (const l of this.header.orgLines ?? []) {
        this.textAt(x, ly, l, 8.5, false, MUTED);
        ly -= 11;
      }
      top -= Math.max(this.logo ? logoSize : 0, top - ly) + 10;
      this.line(MARGIN, top, PAGE_W - MARGIN, top, NAVY, 1.4);
      top -= 24;
      this.textAt(MARGIN, top, this.header.title, 15, true);
      top -= 15;
      if (this.header.subtitle) {
        this.textAt(MARGIN, top, this.header.subtitle, 9.5, false, MUTED);
        top -= 14;
      }
      top -= 6;
    } else {
      this.textAt(MARGIN, top - 8, `${this.header.title} (lanjutan)`, 9, true, MUTED);
      top -= 24;
    }
    this.y = top;
  }

  private ensure(height: number) {
    if (this.y - height < MARGIN + 28) this.newPage();
  }

  // ---------- blok ----------
  heading(text: string) {
    this.ensure(30);
    this.y -= 8;
    this.textAt(MARGIN, this.y - 11, text, 11.5, true, NAVY);
    this.y -= 18;
    return this;
  }

  paragraph(text: string, opts: { size?: number; bold?: boolean; muted?: boolean } = {}) {
    const size = opts.size ?? 9.5;
    for (const l of wrapText(text, CONTENT_W, size, opts.bold)) {
      this.ensure(size + 4);
      this.textAt(MARGIN, this.y - size, l, size, opts.bold, opts.muted ? MUTED : INK);
      this.y -= size + 3.5;
    }
    this.y -= 4;
    return this;
  }

  keyValues(pairs: [string, string][]) {
    const keyW = 130;
    for (const [k, v] of pairs) {
      const lines = wrapText(v || '-', CONTENT_W - keyW, 9.5);
      this.ensure(lines.length * 13 + 2);
      this.textAt(MARGIN, this.y - 9.5, k, 9.5, false, MUTED);
      for (const l of lines) {
        this.textAt(MARGIN + keyW, this.y - 9.5, l, 9.5);
        this.y -= 13;
      }
    }
    this.y -= 4;
    return this;
  }

  table(columns: PdfColumn[], rows: string[][], opts: { totalRow?: string[] } = {}) {
    const size = 8.5;
    const pad = 4;
    const widths = columns.map((c) => c.width * CONTENT_W);
    const drawHeader = () => {
      this.ensure(22);
      this.rect(MARGIN, this.y - 16, CONTENT_W, 16, [0.95, 0.95, 0.97]);
      let x = MARGIN;
      columns.forEach((c, i) => {
        const tw = textWidth(c.header, size, true);
        const tx = c.align === 'right' ? x + widths[i] - pad - tw : x + pad;
        this.textAt(tx, this.y - 11.5, c.header, size, true, MUTED);
        x += widths[i];
      });
      this.y -= 18;
    };
    const drawRow = (cells: string[], bold = false) => {
      const wrapped = cells.map((cell, i) => wrapText(cell ?? '', widths[i] - pad * 2, size, bold));
      const h = Math.max(...wrapped.map((w) => w.length)) * (size + 3) + 5;
      if (this.y - h < MARGIN + 28) {
        this.newPage();
        drawHeader();
      }
      let x = MARGIN;
      wrapped.forEach((lines, i) => {
        lines.forEach((l, li) => {
          const tw = textWidth(l, size, bold);
          const tx = columns[i].align === 'right' ? x + widths[i] - pad - tw : x + pad;
          this.textAt(tx, this.y - size - li * (size + 3), l, size, bold);
        });
        x += widths[i];
      });
      this.y -= h;
      this.line(MARGIN, this.y + 2, MARGIN + CONTENT_W, this.y + 2);
    };
    drawHeader();
    if (rows.length === 0) {
      this.textAt(MARGIN + pad, this.y - size, 'Tidak ada data.', size, false, MUTED);
      this.y -= size + 8;
    }
    for (const r of rows) drawRow(r);
    if (opts.totalRow) drawRow(opts.totalRow, true);
    this.y -= 8;
    return this;
  }

  amountBox(label: string, value: string) {
    this.ensure(44);
    this.rect(MARGIN, this.y - 36, CONTENT_W, 36, [0.97, 0.97, 0.96]);
    this.textAt(MARGIN + 12, this.y - 14, label, 8.5, false, MUTED);
    this.textAt(MARGIN + 12, this.y - 29, value, 15, true);
    this.y -= 46;
    return this;
  }

  stamp(text: string) {
    this.ensure(30);
    const w = textWidth(text, 14, true) + 20;
    this.color([0.7, 0.14, 0.09], true);
    this.ops.push(`1.6 w ${MARGIN} ${(this.y - 26).toFixed(2)} ${w.toFixed(2)} 24 re S`);
    this.textAt(MARGIN + 10, this.y - 19, text, 14, true, [0.7, 0.14, 0.09]);
    this.y -= 34;
    return this;
  }

  signature(label: string, name: string) {
    this.ensure(80);
    const x = PAGE_W - MARGIN - 170;
    this.textAt(x, this.y - 10, label, 9, false, MUTED);
    this.line(x, this.y - 58, x + 170, this.y - 58, MUTED, 0.6);
    this.textAt(x, this.y - 70, name, 9.5, true);
    this.y -= 80;
    return this;
  }

  // ---------- keluaran ----------
  toBuffer(meta: { printedAt: string }): Buffer {
    const pages = [...this.pages, this.ops.join('\n')];
    const footer = (i: number) => {
      const parts = [
        `${this.header.confidential ? 'RAHASIA - berisi data pribadi. ' : ''}Dicetak ${meta.printedAt}`,
        `Halaman ${i + 1} dari ${pages.length}`,
      ];
      const right = parts[1];
      return [
        `${LINE.join(' ')} RG 0.6 w ${MARGIN} ${MARGIN + 14} m ${PAGE_W - MARGIN} ${MARGIN + 14} l S`,
        `${MUTED.join(' ')} rg BT /F1 7.5 Tf ${MARGIN} ${MARGIN} Td (${escapePdf(toWinAnsi(parts[0]))}) Tj ET`,
        `BT /F1 7.5 Tf ${(PAGE_W - MARGIN - textWidth(right, 7.5)).toFixed(2)} ${MARGIN} Td (${escapePdf(right)}) Tj ET`,
      ].join('\n');
    };

    const objects: Buffer[] = [];
    const add = (body: Buffer | string) => {
      objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
      return objects.length;
    };
    const stream = (dict: string, data: Buffer) =>
      Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);

    const catalogId = add(''); // diisi belakangan
    const pagesId = add('');
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const img = this.logo
      ? add(stream(`/Type /XObject /Subtype /Image /Width ${this.logo.width} /Height ${this.logo.height} /ColorSpace ${this.logo.colorSpace} /BitsPerComponent 8 /Filter /DCTDecode`, this.logo.data))
      : null;
    const resources = `<< /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${img ? ` /XObject << /Im1 ${img} 0 R >>` : ''} >>`;
    const pageIds: number[] = [];
    pages.forEach((content, i) => {
      const data = deflateSync(Buffer.from(`${content}\n${footer(i)}`, 'latin1'));
      const contentId = add(stream('/Filter /FlateDecode', data));
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources ${resources} /Contents ${contentId} 0 R >>`));
    });
    objects[catalogId - 1] = Buffer.from(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`, 'latin1');
    objects[pagesId - 1] = Buffer.from(`<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`, 'latin1');
    const infoId = add(`<< /Title (${escapePdf(toWinAnsi(this.header.title))}) /Producer (Rumah Bintang) >>`);

    const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
    const offsets: number[] = [];
    let pos = chunks[0].length;
    objects.forEach((body, i) => {
      offsets.push(pos);
      const obj = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
      chunks.push(obj);
      pos += obj.length;
    });
    const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(chunks);
  }
}

export function pdfReply(reply: import('fastify').FastifyReply, file: Buffer, filename: string) {
  return reply
    .header('Content-Type', 'application/pdf')
    .header('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.\-]+/g, '_')}"`)
    .header('X-Content-Type-Options', 'nosniff')
    .send(file);
}
