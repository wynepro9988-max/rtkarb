import type { AuthContext } from '../authz/context.ts';
import type { Db } from '../db.ts';
import { loadLogo, PdfReport } from './pdf.ts';

const rupiah = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
export const rp = (n: number | null | undefined) => (n === null || n === undefined ? '-' : rupiah.format(n));

const dateLong = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
export const tgl = (d: string | null | undefined) => (d ? dateLong.format(new Date(`${String(d).slice(0, 10)}T00:00:00Z`)) : '-');

export const waktu = (d: Date | string, timeZone: string) =>
  new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(d));

export const METHOD_LABEL: Record<string, string> = { tunai: 'Tunai', transfer: 'Transfer bank', qris: 'QRIS (dicatat manual)' };

// Kop dokumen PDF berisi identitas organisasi aktif + logo resmi.
export async function orgPdf(db: Db, ctx: AuthContext, title: string, subtitle?: string, confidential = false): Promise<PdfReport> {
  const org = await db.one<{ name: string; address: string | null; phone: string | null }>(
    `SELECT name, address, phone FROM organizations WHERE id = $1`,
    [ctx.orgId],
  );
  return new PdfReport({
    orgName: org.name,
    orgLines: [org.address, org.phone ? `Telp. ${org.phone}` : null, 'Pusat Kemandirian dan Tumbuh Kembang Anak'].filter(Boolean) as string[],
    title,
    subtitle,
    confidential,
    logo: loadLogo(),
  });
}

export const printedAt = (ctx: AuthContext) => waktu(new Date(), ctx.timezone);
