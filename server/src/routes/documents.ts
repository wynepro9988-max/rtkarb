import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { needTenant, tenantTx } from '../authz/context.ts';
import type { Db } from '../db.ts';
import { dataScopes } from '../authz/permissions.ts';
import { badRequest, forbidden, HttpError, notFound } from '../errors.ts';
import { idParam, parse, zText } from '../http.ts';
import { requirePatient } from './patients.ts';

// Jenis berkas diverifikasi dari isi (magic bytes), bukan dari nama/Content-Type kiriman klien.
function sniffMime(buf: Buffer): 'application/pdf' | 'image/jpeg' | 'image/png' | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

const EXT: Record<string, string> = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' };

const fieldsSchema = z.object({
  title: zText(2, 150),
  category: z.enum(['administrasi', 'klinis']),
});

export async function documentRoutes(app: FastifyInstance) {
  // Kuota penyimpanan per organisasi (lihat ORG_STORAGE_QUOTA_MB) agar total tetap di bawah batas penyedia.
  const assertQuota = async (db: Db, incoming: number) => {
    const { used } = await db.one<{ used: number }>(`SELECT org_storage_bytes() AS used`);
    if (used + incoming > app.config.orgStorageQuotaBytes) {
      throw new HttpError(413, 'Kuota penyimpanan dokumen organisasi sudah penuh. Hubungi owner/admin teknis.', 'quota_exceeded');
    }
  };

  app.get('/org/storage', async (req) => {
    const ctx = needTenant(req, 'document.upload', 'org.settings.manage');
    const { used } = await tenantTx(app, ctx, (db) => db.one<{ used: number }>(`SELECT org_storage_bytes() AS used`));
    return { usedBytes: used, quotaBytes: app.config.orgStorageQuotaBytes, maxUploadBytes: app.config.maxUploadBytes };
  });

  app.get('/patients/:id/documents', async (req) => {
    const ctx = needTenant(req, 'document.read');
    const id = idParam(req.params);
    return tenantTx(app, ctx, async (db) => {
      await requirePatient(db, ctx.orgId!, id);
      return db.many(
        `SELECT d.id, d.category, d.title, d.original_name, d.mime_type, d.size_bytes, d.uploaded_at, u.full_name AS uploaded_by_name
           FROM patient_documents d LEFT JOIN users u ON u.id = d.uploaded_by
          WHERE d.organization_id = $1 AND d.patient_id = $2 AND d.archived_at IS NULL
          ORDER BY d.uploaded_at DESC`,
        [ctx.orgId, id],
      );
    });
  });

  app.post('/patients/:id/documents', async (req, reply) => {
    const ctx = needTenant(req, 'document.upload');
    const patientId = idParam(req.params);
    const part = await req.file();
    if (!part) throw badRequest('Berkas belum dipilih');

    const fields = parse(fieldsSchema, {
      title: (part.fields.title as { value?: unknown } | undefined)?.value,
      category: (part.fields.category as { value?: unknown } | undefined)?.value,
    });
    if (fields.category === 'klinis' && dataScopes(ctx.permissions).note === 'none') {
      throw forbidden('Anda tidak memiliki akses untuk mengunggah dokumen klinis');
    }

    const buf = await part.toBuffer();
    if (part.file.truncated) throw new HttpError(413, 'Ukuran berkas melebihi batas', 'too_large');
    if (buf.length === 0) throw badRequest('Berkas kosong');
    const mime = sniffMime(buf);
    if (!mime) throw badRequest('Jenis berkas tidak didukung. Gunakan PDF, JPG, atau PNG.');

    // Pemeriksaan awal kuota (murah) sebelum mengirim berkas ke penyimpanan.
    await tenantTx(app, ctx, async (db) => {
      await requirePatient(db, ctx.orgId!, patientId);
      await assertQuota(db, buf.length);
    });

    const storageKey = `${ctx.orgId}/${randomUUID()}${EXT[mime]}`;
    await app.fileStore.put(storageKey, buf, mime);

    try {
      const row = await tenantTx(app, ctx, async (db) => {
        // Pemeriksaan final dalam transaksi, dikunci per organisasi agar unggahan bersamaan tidak melewati kuota.
        await db.exec(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`storage:${ctx.orgId}`]);
        await requirePatient(db, ctx.orgId!, patientId);
        await assertQuota(db, buf.length);
        const d = await db.one<{ id: string }>(
          `INSERT INTO patient_documents (organization_id, patient_id, category, title, original_name, mime_type, size_bytes, storage_key, sha256, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [
            ctx.orgId,
            patientId,
            fields.category,
            fields.title,
            path.basename(part.filename || 'berkas').slice(0, 255),
            mime,
            buf.length,
            storageKey,
            createHash('sha256').update(buf).digest('hex'),
            ctx.userId,
          ],
        );
        await audit(db, req, ctx, { action: 'dokumen.diunggah', entityType: 'patient', entityId: patientId, meta: { dokumen_id: d.id, kategori: fields.category } });
        return d;
      });
      return reply.status(201).send(row);
    } catch (err) {
      await app.fileStore.remove(storageKey).catch((e) => req.log.error({ err: { message: (e as Error).message } }, 'gagal menghapus berkas yatim'));
      throw err;
    }
  });

  app.get('/documents/:id/download', async (req, reply) => {
    const ctx = needTenant(req, 'document.read');
    const id = idParam(req.params);
    const doc = await tenantTx(app, ctx, async (db) => {
      const d = await db.maybe<{ storageKey: string; mimeType: string; originalName: string; patientId: string }>(
        `SELECT storage_key, mime_type, original_name, patient_id FROM patient_documents
          WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL`,
        [ctx.orgId, id],
      );
      if (!d) throw notFound('Dokumen');
      await audit(db, req, ctx, { action: 'dokumen.diunduh', entityType: 'patient', entityId: d.patientId, meta: { dokumen_id: id } });
      return d;
    });
    // storage_key dibuat server (orgId/uuid.ext); tetap dipastikan milik organisasi aktif.
    if (!doc.storageKey.startsWith(`${ctx.orgId}/`)) throw notFound('Dokumen');
    const data = await app.fileStore.get(doc.storageKey);
    const safeName = doc.originalName.replace(/[^\w.\- ]+/g, '_');
    return reply
      .header('Content-Type', doc.mimeType)
      .header('Content-Disposition', `attachment; filename="${safeName}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .send(data);
  });

  app.post('/documents/:id/archive', async (req) => {
    const ctx = needTenant(req, 'document.archive');
    const id = idParam(req.params);
    await tenantTx(app, ctx, async (db) => {
      const n = await db.exec(
        `UPDATE patient_documents SET archived_at = now(), archived_by = $3 WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL`,
        [ctx.orgId, id, ctx.userId],
      );
      if (n === 0) throw notFound('Dokumen');
      await audit(db, req, ctx, { action: 'dokumen.diarsipkan', entityType: 'patient_document', entityId: id });
    });
    return { ok: true };
  });
}
