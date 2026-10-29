import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { needTenant, tenantTx } from '../authz/context.ts';
import { parse, zPaging, zRange } from '../http.ts';

export async function auditLogRoutes(app: FastifyInstance) {
  app.get('/audit', async (req) => {
    const ctx = needTenant(req, 'audit.read');
    const q = parse(
      zRange.and(zPaging).and(
        z.object({
          action: z.string().trim().max(60).optional(),
          entityType: z.string().trim().max(40).optional(),
          entityId: z.string().trim().max(60).optional(),
        }),
      ),
      req.query,
    );
    return tenantTx(app, ctx, async (db) => {
      const rows = await db.many<{ total: number }>(
        `SELECT l.id, l.created_at, l.action, l.entity_type, l.entity_id, l.meta, l.ip, l.support_grant_id,
                coalesce(u.full_name, g.requested_by_name) AS actor_name,
                (l.support_grant_id IS NOT NULL) AS via_support,
                count(*) OVER () AS total
           FROM audit_logs l
           LEFT JOIN users u ON u.id = l.actor_user_id
           LEFT JOIN support_access_grants g ON g.organization_id = l.organization_id AND g.id = l.support_grant_id
          WHERE l.organization_id = $1
            AND l.created_at >= ($2::date)::timestamp AT TIME ZONE $4
            AND l.created_at < ($3::date + 1)::timestamp AT TIME ZONE $4
            AND ($5::text IS NULL OR l.action LIKE $5 || '%')
            AND ($6::text IS NULL OR l.entity_type = $6)
            AND ($7::text IS NULL OR l.entity_id = $7)
          ORDER BY l.created_at DESC, l.id DESC
          LIMIT $8 OFFSET $9`,
        [ctx.orgId, q.from, q.to, ctx.timezone, q.action ?? null, q.entityType ?? null, q.entityId ?? null, q.limit, q.offset],
      );
      return { total: rows[0]?.total ?? 0, items: rows.map(({ total: _t, ...r }) => r) };
    });
  });
}
