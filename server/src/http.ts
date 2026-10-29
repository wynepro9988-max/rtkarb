import { z } from 'zod';
import { HttpError, notFound } from './errors.ts';

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError(
      400,
      'Data yang dikirim belum valid',
      'validation',
      result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

// ID yang tidak valid diperlakukan sama dengan data yang tidak ada.
export function idParam(params: unknown, name = 'id'): string {
  const value = (params as Record<string, unknown> | undefined)?.[name];
  const ok = z.uuid().safeParse(value);
  if (!ok.success) throw notFound();
  return ok.data;
}

const isRealDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export const zDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal harus YYYY-MM-DD')
  .refine(isRealDate, 'Tanggal tidak valid');

export const zTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Format jam harus HH:MM');

export const zText = (min: number, max: number) =>
  z.string().trim().min(min, `Minimal ${min} karakter`).max(max, `Maksimal ${max} karakter`);

export const zOptText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Maksimal ${max} karakter`)
    .nullish()
    .transform((v) => (v ? v : null));

export const zMoney = z.number().int('Nominal harus bilangan bulat').min(0).max(1_000_000_000_000);
export const zPositiveMoney = z.number().int('Nominal harus bilangan bulat').min(1, 'Nominal harus lebih dari 0').max(1_000_000_000_000);
export const zMethod = z.enum(['tunai', 'transfer', 'qris']);
export const zId = z.uuid('ID tidak valid');

export const zRange = z
  .object({ from: zDate, to: zDate })
  .refine((r) => r.from <= r.to, 'Tanggal awal harus sebelum tanggal akhir')
  .refine(
    (r) => (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 <= 366,
    'Rentang tanggal maksimal 1 tahun',
  );

export const zPaging = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
