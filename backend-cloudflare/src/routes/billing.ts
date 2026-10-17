import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { ensureMonthlyGrant, getWalletSummary, listLedger } from "../billing/credits";
import { listUsageEvents } from "../billing/usage";

export const billingRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

billingRoutes.use("*", requireAuth);

// GET /billing/wallet — current balance + this month's allowance. Tenant-
// isolated by construction: always reads/writes tenant.tenantId from the
// verified auth context, never a client-supplied id.
billingRoutes.get("/wallet", async (c) => {
  const sql = c.get("sql");
  const tenant = c.get("tenant");
  await ensureMonthlyGrant(sql, tenant.tenantId, tenant.planTier);
  const wallet = await getWalletSummary(sql, tenant.tenantId);
  return c.json(wallet);
});

// GET /billing/ledger — recent balance-affecting entries (reserves,
// refunds, monthly grants). This is the auditable money trail.
billingRoutes.get("/ledger", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
  const entries = await listLedger(c.get("sql"), c.get("tenant").tenantId, limit);
  return c.json(entries);
});

// GET /billing/usage — recent metered-call attempts, including ones that
// were denied for insufficient credits (credits_consumed: 0). Useful for
// "why did my GST sync not run" support questions.
billingRoutes.get("/usage", async (c) => {
  const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10) || 100, 500);
  const events = await listUsageEvents(c.get("sql"), c.get("tenant").tenantId, limit);
  return c.json(events);
});
