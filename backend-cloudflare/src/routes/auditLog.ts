// GET /api/v1/audit-log — the tenant-wide Audit Trail screen
// (frontend AuditLogView). Per-document history stays at
// GET /documents/:id/audit-log. Read-only; scoped to the caller's tenant by
// both the query and row-level security.
import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { requireFeature } from "../billing/featureGate";
import { listAuditLog } from "../repository/auditLog";
import { apiError } from "../http";

export const auditLogRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

auditLogRoutes.use("*", requireAuth);
auditLogRoutes.use("*", requireFeature("audit_log"));

const ENTITY_TYPE = /^[A-Z][A-Z0-9_]{0,39}$/;
// audit_log.entity_id is a uuid column: anything else would make Postgres throw (a 500), so reject it up front.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

auditLogRoutes.get("/", async (c) => {
  const entityType = c.req.query("entity_type");
  const entityId = c.req.query("entity_id");
  const rawLimit = c.req.query("limit");

  if (entityType && !ENTITY_TYPE.test(entityType)) return apiError(c, 400, "VALIDATION_ERROR", "invalid entity_type");
  if (entityId && !UUID.test(entityId)) return apiError(c, 400, "VALIDATION_ERROR", "invalid entity_id");
  const limit = rawLimit === undefined ? 100 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) return apiError(c, 400, "VALIDATION_ERROR", "limit must be a positive integer");

  const items = await listAuditLog(c.get("sql"), c.get("tenant").tenantId, { entityType, entityId, limit });
  return c.json({ items });
});
