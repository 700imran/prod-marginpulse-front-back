import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import {
  getReconciliationSettings, updateReconciliationSettings,
  getNotificationSettings, updateNotificationSettings,
  getIntegrationSettings, updateIntegrationSettings,
} from "../repository/settings";

export const settingsRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

settingsRoutes.use("*", requireAuth);

settingsRoutes.get("/reconciliation", async (c) => c.json(await getReconciliationSettings(c.get("sql"), c.get("tenant").tenantId)));
settingsRoutes.patch("/reconciliation", async (c) => {
  const patch = await c.req.json();
  await updateReconciliationSettings(c.get("sql"), c.get("tenant").tenantId, patch);
  return c.json(await getReconciliationSettings(c.get("sql"), c.get("tenant").tenantId));
});

settingsRoutes.get("/notifications", async (c) => c.json(await getNotificationSettings(c.get("sql"), c.get("tenant").tenantId)));
settingsRoutes.patch("/notifications", async (c) => {
  const patch = await c.req.json();
  await updateNotificationSettings(c.get("sql"), c.get("tenant").tenantId, patch);
  return c.json(await getNotificationSettings(c.get("sql"), c.get("tenant").tenantId));
});

settingsRoutes.get("/integrations", async (c) => c.json(await getIntegrationSettings(c.get("sql"), c.get("tenant").tenantId)));
settingsRoutes.patch("/integrations", async (c) => {
  const patch = await c.req.json();
  await updateIntegrationSettings(c.get("sql"), c.get("tenant").tenantId, patch);
  return c.json(await getIntegrationSettings(c.get("sql"), c.get("tenant").tenantId));
});
