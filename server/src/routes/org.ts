import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, changedFields } from '../audit.ts';
import { needTenant, tenantTx } from '../authz/context.ts';
import { notFound } from '../errors.ts';
import { idParam, parse, zMoney, zOptText, zText } from '../http.ts';

const ORG_FIELDS = `id, name, status, timezone, patient_code_prefix, receipt_prefix, invoice_prefix, address, phone,
  finance_discount_max_percent, reminder_template, retention_years, created_at`;

const orgPatch = z.object({
  name: zText(2, 200).optional(),
  timezone: z.enum(['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura']).optional(),
  patientCodePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, 'Hanya huruf/angka, maksimal 8').optional(),
  receiptPrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, 'Hanya huruf/angka, maksimal 8').optional(),
  address: zOptText(500).optional(),
  phone: zOptText(40).optional(),
  invoicePrefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, 'Hanya huruf/angka, maksimal 8').optional(),
  // Kebijakan diskon kasir (persen). 0 = hanya owner yang dapat memberi diskon.
  financeDiscountMaxPercent: z.number().min(0).max(100).optional(),
  reminderTemplate: zOptText(600).optional(),
  // Kandidat retensi: pasien tidak aktif lebih dari N tahun (tanpa penghapusan otomatis).
  retentionYears: z.number().int().min(1).max(50).nullish(),
});

const serviceBody = z.object({
  name: zText(2, 120),
  defaultDurationMinutes: z.number().int().min(5).max(480).default(60),
  defaultPrice: zMoney.default(0),
});
const servicePatch = serviceBody.partial().extend({ active: z.boolean().optional() });

const packageTypeBody = z.object({
  name: zText(2, 120),
  serviceId: z.uuid().nullish(),
  sessionsTotal: z.number().int().min(1).max(500),
  price: zMoney,
  validDays: z.number().int().min(1).max(3650).nullish(),
});
const packageTypePatch = z.object({
  name: zText(2, 120).optional(),
  price: zMoney.optional(),
  validDays: z.number().int().min(1).max(3650).nullish(),
  active: z.boolean().optional(),
});

const COLUMN: Record<string, string> = {
  name: 'name',
  timezone: 'timezone',
  patientCodePrefix: 'patient_code_prefix',
  receiptPrefix: 'receipt_prefix',
  address: 'address',
  phone: 'phone',
  invoicePrefix: 'invoice_prefix',
  financeDiscountMaxPercent: 'finance_discount_max_percent',
  reminderTemplate: 'reminder_template',
  retentionYears: 'retention_years',
  defaultDurationMinutes: 'default_duration_minutes',
  defaultPrice: 'default_price',
  active: 'active',
  price: 'price',
  validDays: 'valid_days',
};

// Membangun klausa SET dari patch yang sudah divalidasi (nama kolom dari whitelist).
export function setClause(patch: Record<string, unknown>, startIndex: number, columns = COLUMN) {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined && columns[k]);
  return {
    keys,
    sql: keys.map((k, i) => `${columns[k]} = $${startIndex + i}`).join(', '),
    values: keys.map((k) => patch[k]),
  };
}

export async function orgRoutes(app: FastifyInstance) {
  app.get('/org', async (req) => {
    const ctx = needTenant(req, 'org.read');
    return tenantTx(app, ctx, (db) => db.one(`SELECT ${ORG_FIELDS} FROM organizations WHERE id = $1`, [ctx.orgId]));
  });

  app.patch('/org', async (req) => {
    const ctx = needTenant(req, 'org.settings.manage');
    const patch = parse(orgPatch, req.body);
    return tenantTx(app, ctx, async (db) => {
      const before = await db.one<Record<string, unknown>>(`SELECT ${ORG_FIELDS} FROM organizations WHERE id = $1`, [ctx.orgId]);
      const set = setClause(patch, 2);
      if (set.keys.length === 0) return before;
      const row = await db.one(`UPDATE organizations SET ${set.sql} WHERE id = $1 RETURNING ${ORG_FIELDS}`, [ctx.orgId, ...set.values]);
      await audit(db, req, ctx, {
        action: 'organisasi.diubah',
        entityType: 'organization',
        entityId: ctx.orgId,
        meta: { field: changedFields(before, patch) },
      });
      return row;
    });
  });

  // ---- Layanan terapi ----
  app.get('/services', async (req) => {
    const ctx = needTenant(req, 'org.read');
    return tenantTx(app, ctx, (db) =>
      db.many(
        `SELECT id, name, default_duration_minutes, default_price, active
           FROM therapy_services WHERE organization_id = $1 ORDER BY active DESC, name`,
        [ctx.orgId],
      ),
    );
  });

  app.post('/services', async (req, reply) => {
    const ctx = needTenant(req, 'catalog.manage');
    const body = parse(serviceBody, req.body);
    const row = await tenantTx(app, ctx, async (db) => {
      const s = await db.one<{ id: string }>(
        `INSERT INTO therapy_services (organization_id, name, default_duration_minutes, default_price)
         VALUES ($1, $2, $3, $4) RETURNING id, name, default_duration_minutes, default_price, active`,
        [ctx.orgId, body.name, body.defaultDurationMinutes, body.defaultPrice],
      );
      await audit(db, req, ctx, { action: 'layanan.dibuat', entityType: 'service', entityId: s.id });
      return s;
    });
    return reply.status(201).send(row);
  });

  app.patch('/services/:id', async (req) => {
    const ctx = needTenant(req, 'catalog.manage');
    const id = idParam(req.params);
    const patch = parse(servicePatch, req.body);
    return tenantTx(app, ctx, async (db) => {
      const set = setClause(patch, 3);
      const row = set.keys.length
        ? await db.maybe(
            `UPDATE therapy_services SET ${set.sql} WHERE organization_id = $1 AND id = $2
             RETURNING id, name, default_duration_minutes, default_price, active`,
            [ctx.orgId, id, ...set.values],
          )
        : await db.maybe(`SELECT id, name, default_duration_minutes, default_price, active FROM therapy_services WHERE organization_id = $1 AND id = $2`, [ctx.orgId, id]);
      if (!row) throw notFound('Layanan');
      await audit(db, req, ctx, { action: 'layanan.diubah', entityType: 'service', entityId: id, meta: { field: set.keys } });
      return row;
    });
  });

  // ---- Jenis paket ----
  const PT_FIELDS = `pt.id, pt.name, pt.service_id, s.name AS service_name, pt.sessions_total, pt.price, pt.valid_days, pt.active`;

  app.get('/package-types', async (req) => {
    const ctx = needTenant(req, 'package.read', 'catalog.manage');
    return tenantTx(app, ctx, (db) =>
      db.many(
        `SELECT ${PT_FIELDS} FROM package_types pt
           LEFT JOIN therapy_services s ON s.organization_id = pt.organization_id AND s.id = pt.service_id
          WHERE pt.organization_id = $1 ORDER BY pt.active DESC, pt.name`,
        [ctx.orgId],
      ),
    );
  });

  app.post('/package-types', async (req, reply) => {
    const ctx = needTenant(req, 'catalog.manage');
    const body = parse(packageTypeBody, req.body);
    const row = await tenantTx(app, ctx, async (db) => {
      const pt = await db.one<{ id: string }>(
        `INSERT INTO package_types (organization_id, name, service_id, sessions_total, price, valid_days)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [ctx.orgId, body.name, body.serviceId ?? null, body.sessionsTotal, body.price, body.validDays ?? null],
      );
      await audit(db, req, ctx, { action: 'jenis_paket.dibuat', entityType: 'package_type', entityId: pt.id });
      return db.one(
        `SELECT ${PT_FIELDS} FROM package_types pt
           LEFT JOIN therapy_services s ON s.organization_id = pt.organization_id AND s.id = pt.service_id
          WHERE pt.organization_id = $1 AND pt.id = $2`,
        [ctx.orgId, pt.id],
      );
    });
    return reply.status(201).send(row);
  });

  app.patch('/package-types/:id', async (req) => {
    const ctx = needTenant(req, 'catalog.manage');
    const id = idParam(req.params);
    const patch = parse(packageTypePatch, req.body);
    return tenantTx(app, ctx, async (db) => {
      const set = setClause(patch, 3);
      if (set.keys.length) {
        const n = await db.exec(`UPDATE package_types SET ${set.sql} WHERE organization_id = $1 AND id = $2`, [ctx.orgId, id, ...set.values]);
        if (n === 0) throw notFound('Jenis paket');
        await audit(db, req, ctx, { action: 'jenis_paket.diubah', entityType: 'package_type', entityId: id, meta: { field: set.keys } });
      }
      const row = await db.maybe(
        `SELECT ${PT_FIELDS} FROM package_types pt
           LEFT JOIN therapy_services s ON s.organization_id = pt.organization_id AND s.id = pt.service_id
          WHERE pt.organization_id = $1 AND pt.id = $2`,
        [ctx.orgId, id],
      );
      if (!row) throw notFound('Jenis paket');
      return row;
    });
  });
}
