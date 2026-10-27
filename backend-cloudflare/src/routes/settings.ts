import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { pickValid, ValidationError, type Schema } from "../security/validate";
import {
  getReconciliationSettings, updateReconciliationSettings,
  getNotificationSettings, updateNotificationSettings,
  getIntegrationSettings, updateIntegrationSettings,
} from "../repository/settings";

const RECON_SCHEMA: Schema = {
  fuzzyVendorMatching: { t: "bool" },
  dateDriftToleranceDays: { t: "int", min: 0, max: 30 },
  ocrConfidenceThreshold: { t: "num", min: 0, max: 1 },
};
const NOTIF_SCHEMA: Schema = {
  criticalItcMissingAlert: { t: "bool" },
  criticalItcThresholdInr: { t: "num", min: 0, max: 1_000_000_000 },
  weeklyAuditSummary: { t: "bool" },
};
const INTEG_SCHEMA: Schema = {
  gstAutoSyncEnabled: { t: "bool" },
  gstAutoSyncDayOfMonth: { t: "int", min: 1, max: 28 },
  whatsappOutboundEnabled: { t: "bool" },
};
async function body(c: { req: { json(): Promise<unknown> } }, schema: Schema) {
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw new ValidationError("body", "must be valid JSON"); }
  return pickValid(raw, schema);
}

export const settingsRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

settingsRoutes.use("*", requireAuth);

settingsRoutes.get("/reconciliation", async (c) => c.json(await getReconciliationSettings(c.get("sql"), c.get("tenant").tenantId)));
settingsRoutes.patch("/reconciliation", async (c) => {
  const patch = await body(c, RECON_SCHEMA);
  await updateReconciliationSettings(c.get("sql"), c.get("tenant").tenantId, patch);
  return c.json(await getReconciliationSettings(c.get("sql"), c.get("tenant").tenantId));
});

settingsRoutes.get("/notifications", async (c) => c.json(await getNotificationSettings(c.get("sql"), c.get("tenant").tenantId)));
settingsRoutes.patch("/notifications", async (c) => {
  const patch = await body(c, NOTIF_SCHEMA);
  await updateNotificationSettings(c.get("sql"), c.get("tenant").tenantId, patch);
  return c.json(await getNotificationSettings(c.get("sql"), c.get("tenant").tenantId));
});

settingsRoutes.get("/integrations", async (c) => c.json(await getIntegrationSettings(c.get("sql"), c.get("tenant").tenantId)));
settingsRoutes.patch("/integrations", async (c) => {
  const patch = await body(c, INTEG_SCHEMA);
  await updateIntegrationSettings(c.get("sql"), c.get("tenant").tenantId, patch);
  return c.json(await getIntegrationSettings(c.get("sql"), c.get("tenant").tenantId));
});
