import { Hono } from "hono";
import type { Env } from "./config";
import type { Sql } from "./db";
import type { TenantContext } from "./auth/supabase";
import { withDb } from "./middleware/db";
import { requestId, securityHeaders, corsMiddleware } from "./middleware/security";
import { healthRoutes } from "./routes/health";
import { authRoutes } from "./routes/auth";
import { documentRoutes } from "./routes/documents";
import { reconciliationRoutes } from "./routes/reconciliation";
import { taxIdentifierRoutes } from "./routes/taxIdentifiers";
import { bankAccountRoutes } from "./routes/bankAccounts";
import { teamRoutes } from "./routes/team";
import { settingsRoutes } from "./routes/settings";
import { gstRoutes } from "./routes/gst";
import { commsRoutes } from "./routes/comms";
import { roiRoutes } from "./routes/roi";
import { adminRoutes } from "./routes/admin";
import { integrationRoutes } from "./routes/integrations";
import { webhookRoutes } from "./routes/webhooks";
import { handleQueueBatch } from "./queue/consumer";
import { getDb } from "./db";
import { listAllTenants } from "./repository/tenants";
import { detectMissingInvoices } from "./pipelines/missingInvoice";

const app = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

app.use("*", requestId, securityHeaders, corsMiddleware(), withDb);

// health check sits outside /api/v1, same as the Go router
app.route("/", healthRoutes);

app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/documents", documentRoutes);
app.route("/api/v1/reconciliation", reconciliationRoutes);
app.route("/api/v1/tax-identifiers", taxIdentifierRoutes);
app.route("/api/v1/bank-accounts", bankAccountRoutes);
app.route("/api/v1/team", teamRoutes);
app.route("/api/v1/settings", settingsRoutes);
app.route("/api/v1/gst", gstRoutes);
app.route("/api/v1/comms", commsRoutes);
app.route("/api/v1/roi", roiRoutes); // unauthenticated by design — see routes/roi.ts
app.route("/api/v1/admin", adminRoutes);
app.route("/api/v1/integrations", integrationRoutes);
app.route("/webhook", webhookRoutes); // unauthenticated — see routes/webhooks.ts

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error("unhandled_error", { path: c.req.path, error: err.message });
  return c.json({ error: "internal server error" }, 500);
});

export default {
  fetch: app.fetch,

  // Cloudflare Queues consumer — drains all 5 queues (wrangler.toml),
  // dispatching by the message's "task" field. See queue/consumer.ts.
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    await handleQueueBatch(batch as MessageBatch<any>, env);
  },

  // Cron Trigger (wrangler.toml: daily at 03:00) — replaces the
  // never-built EventBridge rule from ROADMAP.md for a daily
  // detect-missing-invoices sweep across every tenant.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const sql = getDb(env);
    try {
      const tenants = await listAllTenants(sql, 1000, 0);
      for (const tenant of tenants) {
        try {
          const result = await detectMissingInvoices(sql, tenant.tenantId);
          if (result.anomaliesCreated > 0) {
            console.log("scheduled_missing_invoice_sweep", { tenantId: tenant.tenantId, ...result });
          }
        } catch (e) {
          console.error("scheduled_sweep_failed_for_tenant", { tenantId: tenant.tenantId, error: (e as Error).message });
        }
      }
    } finally {
      ctx.waitUntil(sql.end());
    }
  },
};
