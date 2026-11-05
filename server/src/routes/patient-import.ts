import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { can, needTenant, tenantTx, type AuthContext } from '../authz/context.ts';
import type { Db } from '../db.ts';
import { badRequest, HttpError } from '../errors.ts';
import { parse } from '../http.ts';
import { nextCounter } from '../lib/counters.ts';
import {
  analyzeColumns,
  detectLayout,
  FIELD_KEYS,
  fieldGroup,
  IMPORT_FIELDS,
  INTAKE_FIELDS,
  MAX_IMPORT_ROWS,
  MULTI_FIELDS,
  prepareRows,
  type ExistingPatient,
  type ImportField,
  type Mapping,
} from '../lib/patient-import.ts';
import { readSpreadsheet } from '../lib/spreadsheet-read.ts';
import { insertGuardian } from './patients.ts';

// Impor pasien dari Excel/CSV berformat bebas. Tidak ada yang disimpan di server sampai impor
// dijalankan: pratinjau dan impor sama-sama membaca ulang berkas yang dikirim, dengan
// pemetaan kolom yang dipilih pengguna (atau hasil deteksi otomatis bila belum dipilih).

const formFields = z.object({
  sheet: z.coerce.number().int().min(0).max(200).optional(),
  mapping: z.string().max(10_000).optional(),
  skip: z.string().max(20_000).optional(),
  includeDuplicates: z.enum(['true', 'false']).optional(),
});
const mappingSchema = z.record(z.string().regex(/^\d{1,3}$/), z.union([z.enum(FIELD_KEYS as [ImportField, ...ImportField[]]), z.literal('')]));
const skipSchema = z.array(z.number().int().min(1)).max(MAX_IMPORT_ROWS);

const jsonField = <S extends z.ZodType>(schema: S, raw: string | undefined, what: string): z.output<S> | undefined => {
  if (raw === undefined || raw === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw badRequest(`Format ${what} tidak valid`);
  }
  return parse(schema, value);
};

async function readUpload(req: FastifyRequest) {
  const part = await req.file({ limits: { fieldSize: 20_000 } });
  if (!part) throw badRequest('Berkas belum dipilih');
  const value = (name: string) => (part.fields[name] as { value?: unknown } | undefined)?.value;
  const fields = parse(formFields, {
    sheet: value('sheet'),
    mapping: value('mapping'),
    skip: value('skip'),
    includeDuplicates: value('includeDuplicates'),
  });
  const buf = await part.toBuffer();
  if (part.file.truncated) throw new HttpError(413, 'Ukuran berkas melebihi batas', 'too_large');
  if (buf.length === 0) throw badRequest('Berkas kosong');
  return {
    buf,
    sheet: fields.sheet,
    mapping: jsonField(mappingSchema, fields.mapping, 'pemetaan kolom'),
    skip: new Set(jsonField(skipSchema, fields.skip, 'daftar baris') ?? []),
    includeDuplicates: fields.includeDuplicates === 'true',
  };
}

const hasContent = (rows: string[][]) => rows.some((r) => r.some((c) => c.trim()));

function analyze(upload: Awaited<ReturnType<typeof readUpload>>, existing: ExistingPatient[], today: string, allowIntake: boolean) {
  const sheets = readSpreadsheet(upload.buf);
  const candidates = sheets.map((s, index) => ({ ...s, index })).filter((s) => hasContent(s.rows));
  if (!candidates.length) throw badRequest('Berkas tidak berisi data');

  const study = (rows: string[][]) => {
    const layout = detectLayout(rows);
    const data = rows.slice(layout.dataStart);
    return { layout, data, ...analyzeColumns(layout, data) };
  };
  let sheet = candidates[0];
  let result: ReturnType<typeof study>;
  if (upload.sheet !== undefined) {
    const chosen = candidates.find((s) => s.index === upload.sheet);
    if (!chosen) throw badRequest('Lembar kerja tidak ditemukan atau kosong');
    sheet = chosen;
    result = study(sheet.rows);
  } else {
    // Lembar yang paling mirip data pasien: ada kolom nama anak, lalu paling banyak kolom dikenali.
    const scored = candidates.map((s) => {
      const r = study(s.rows);
      return { s, r, score: (r.suggested.size ? [...r.suggested.values()].includes('fullName') ? 100 : 0 : 0) + r.suggested.size };
    });
    const top = scored.reduce((a, b) => (b.score > a.score ? b : a));
    sheet = top.s;
    result = top.r;
  }
  const { layout, data, columns } = result;
  const dataRows = data.filter((r) => r.some((c) => c.trim())).length;
  if (dataRows > MAX_IMPORT_ROWS) {
    throw badRequest(`Berkas berisi ${dataRows} baris data. Maksimal ${MAX_IMPORT_ROWS} baris sekali impor; bagi berkas menjadi beberapa bagian.`);
  }

  let mapping: Mapping = new Map([...result.suggested].filter(([, f]) => allowIntake || !INTAKE_FIELDS.has(f)));
  if (upload.mapping) {
    mapping = new Map();
    const known = new Set(columns.map((c) => c.index));
    for (const [key, field] of Object.entries(upload.mapping)) {
      if (!field) continue;
      const col = Number(key);
      if (!known.has(col)) throw badRequest('Pemetaan menyebut kolom yang tidak ada di berkas');
      if (!allowIntake && INTAKE_FIELDS.has(field)) throw badRequest(`Anda tidak memiliki akses ke "${IMPORT_FIELDS[field]}"`);
      if (!MULTI_FIELDS.has(field) && [...mapping.values()].includes(field)) {
        throw badRequest(`"${IMPORT_FIELDS[field]}" dipilih untuk lebih dari satu kolom`);
      }
      mapping.set(col, field);
    }
  }
  for (const c of columns) c.field = mapping.get(c.index) ?? null;

  const labels = new Map(columns.map((c) => [c.index, c.label || `Kolom ${c.letter}`]));
  const rowNumbers = data.map((_, i) => layout.dataStart + i + 1);
  const hasName = [...mapping.values()].includes('fullName');
  const prepared = hasName
    ? prepareRows(layout, data, rowNumbers, labels, mapping, { today, existing })
    : { rows: [], notices: [`Pilih kolom yang berisi ${IMPORT_FIELDS.fullName.toLowerCase()}.`] };
  if (!layout.headerRows.length) prepared.notices.unshift('Judul kolom tidak ditemukan; jenis kolom ditebak dari isinya. Periksa pilihan di bawah.');

  const count = (status: string) => prepared.rows.filter((r) => r.status === status).length;
  return {
    sheets: candidates.map((s) => ({ index: s.index, name: s.name })),
    sheetIndex: sheet.index,
    headerRows: layout.headerRows.map((r) => r + 1),
    columns,
    hasName,
    notices: prepared.notices,
    summary: { total: prepared.rows.length, siap: count('siap'), duplikat: count('duplikat'), dilewati: count('dilewati') },
    rows: prepared.rows,
  };
}

async function context(db: Db, ctx: AuthContext) {
  const existing = await db.many<ExistingPatient>(`SELECT patient_code, full_name, birth_date FROM patients WHERE organization_id = $1`, [ctx.orgId]);
  const { today } = await db.one<{ today: string }>(`SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') AS today`, [ctx.timezone]);
  return { existing, today };
}

export async function patientImportRoutes(app: FastifyInstance) {
  app.post('/patients/import/preview', async (req) => {
    const ctx = needTenant(req, 'patient.manage');
    const upload = await readUpload(req);
    return tenantTx(app, ctx, async (db) => {
      const { existing, today } = await context(db, ctx);
      const allowIntake = can(ctx, 'patient.intake');
      return {
        fields: FIELD_KEYS.filter((key) => allowIntake || !INTAKE_FIELDS.has(key)).map((key) => ({ key, label: IMPORT_FIELDS[key], multi: MULTI_FIELDS.has(key), group: fieldGroup(key) })),
        ...analyze(upload, existing, today, allowIntake),
      };
    });
  });

  app.post('/patients/import', async (req, reply) => {
    const ctx = needTenant(req, 'patient.manage');
    const upload = await readUpload(req);
    const result = await tenantTx(app, ctx, async (db) => {
      // Satu impor per organisasi pada satu waktu, agar pemeriksaan duplikat tidak saling mendahului.
      await db.exec(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`patient-import:${ctx.orgId}`]);
      const { existing, today } = await context(db, ctx);
      const analysis = analyze(upload, existing, today, can(ctx, 'patient.intake'));
      if (!analysis.hasName) throw badRequest(`Pilih kolom yang berisi ${IMPORT_FIELDS.fullName.toLowerCase()}`);
      const chosen = analysis.rows.filter(
        (r) => !upload.skip.has(r.row) && (r.status === 'siap' || (r.status === 'duplikat' && upload.includeDuplicates)),
      );
      if (!chosen.length) throw badRequest('Tidak ada baris yang dapat diimpor');

      const org = await db.one<{ patientCodePrefix: string }>(`SELECT patient_code_prefix FROM organizations WHERE id = $1`, [ctx.orgId]);
      const codes: string[] = [];
      for (const { patient: p } of chosen) {
        const seq = await nextCounter(db, ctx.orgId!, 'patient');
        const code = `${org.patientCodePrefix}-${String(seq).padStart(4, '0')}`;
        const row = await db.one<{ id: string }>(
          `INSERT INTO patients (organization_id, patient_code, full_name, nickname, birth_place, birth_date, sex, status, registered_on, address, admin_notes, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9::date, current_date), $10, $11, $12, $12)
           RETURNING id`,
          [ctx.orgId, code, p.fullName, p.nickname, p.birthPlace, p.birthDate, p.sex, p.status, p.registeredOn, p.address, p.adminNotes, ctx.userId],
        );
        if (p.intake) {
          await db.exec(
            `INSERT INTO patient_intakes (organization_id, patient_id, complaint, findings, program_notes, created_by, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6, $6)`,
            [ctx.orgId, row.id, p.intake.complaint, p.intake.findings, p.intake.programNotes, ctx.userId],
          );
        }
        for (const g of p.guardians) {
          await insertGuardian(db, ctx.orgId!, row.id, ctx.userId, { ...g, address: null, waOptOut: false });
        }
        codes.push(code);
      }
      const duplicates = chosen.filter((r) => r.status === 'duplikat').length;
      await audit(db, req, ctx, {
        action: 'pasien.diimpor',
        entityType: 'patient',
        entityId: null,
        meta: { jumlah: codes.length, kode_awal: codes[0], kode_akhir: codes[codes.length - 1], duplikat_diimpor: duplicates, tidak_diimpor: analysis.summary.total - codes.length },
      });
      return { created: codes.length, firstCode: codes[0], lastCode: codes[codes.length - 1], notImported: analysis.summary.total - codes.length };
    });
    return reply.status(201).send(result);
  });
}
