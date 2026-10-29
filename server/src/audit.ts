import type { FastifyRequest } from 'fastify';
import type { AuthContext } from './authz/context.ts';
import type { Db } from './db.ts';

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string | null;
  // Hanya metadata (ID, nama field yang berubah, status). Jangan isi klinis.
  meta?: Record<string, unknown>;
}

export interface AuditActor {
  orgId: string | null;
  userId: string | null;
  memberId?: string | null;
  supportGrantId?: string | null;
}

const SECURITY_ACTIONS = /^(auth\.|dukungan\.(diminta|masuk|keluar)|staf\.aktivasi)/;

export async function writeAudit(db: Db, req: FastifyRequest | null, actor: AuditActor, entry: AuditEntry): Promise<void> {
  await db.exec(
    `INSERT INTO audit_logs
       (organization_id, actor_user_id, actor_member_id, support_grant_id, action, entity_type, entity_id, meta, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      actor.orgId,
      actor.userId,
      actor.memberId ?? null,
      actor.supportGrantId ?? null,
      entry.action,
      entry.entityType ?? null,
      entry.entityId ?? null,
      JSON.stringify(entry.meta ?? {}),
      req?.ip ?? null,
      // User-agent hanya untuk kejadian keamanan (hemat ruang database).
      req && SECURITY_ACTIONS.test(entry.action) ? String(req.headers['user-agent'] ?? '').slice(0, 200) : null,
    ],
  );
}

export async function audit(db: Db, req: FastifyRequest, ctx: AuthContext, entry: AuditEntry): Promise<void> {
  // Mode dukungan berjalan READ ONLY; setiap permintaannya dicatat terpisah
  // oleh hook onResponse (lihat app.ts), jadi tidak ditulis di sini.
  if (ctx.mode === 'support') return;
  await writeAudit(
    db,
    req,
    { orgId: ctx.orgId, userId: ctx.userId, memberId: ctx.memberId, supportGrantId: ctx.support?.grantId },
    entry,
  );
}

// Nama field yang berubah (tanpa nilainya) untuk metadata audit.
export function changedFields(before: Record<string, unknown>, patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((k) => patch[k] !== undefined && before[k] !== patch[k]);
}
