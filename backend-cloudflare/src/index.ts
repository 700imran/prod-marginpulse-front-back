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
import { billingRoutes } from "./routes/billing";
import { handleQueueBatch } from "./queue/consumer";
import { getDb } from "./db";
import { listAllTenants } from "./repository/tenants";
import { detectMissingInvoices } from "./pipelines/missingInvoice";
import { runRetentionSweep } from "./purge";
import { setTenantContext, setPrivilegedContext } from "./security/tenantContext";
import { apiError } from "./http";
import { AppError } from "./errors";
import { isProd } from "./config";
import { reportError } from "./monitoring";

const app = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext; requestId: string } }>();

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
app.route("/api/v1/billing", billingRoutes);
app.route("/webhook", webhookRoutes); // unauthenticated — see routes/webhooks.ts

app.notFound((c) => apiError(c, 404, "NOT_FOUND", "not found"));

app.onError((err, c) => {
  const requestId = (c.get("requestId") as string | undefined) ?? crypto.randomUUID();
  if (err instanceof AppError) {
    // A deliberate, expected error a route or pipeline raised on
    // purpose (see src/errors.ts) — err.message is already
    // client-safe by construction, so it's fine to return as-is.
    console.error("app_error", { requestId, path: c.req.path, code: err.code, message: err.message });
    return apiError(c, err.status, err.code, err.message, err.details);
  }
  // Anything else is unexpected: log the full detail — including the
  // stack — server-side only, tagged with the same requestId the client
  // gets back, so a support conversation can be tied to this exact log
  // line without ever showing the client (or an attacker probing error
  // messages) a stack trace, a raw Postgres error, or any other
  // implementation detail. Only in non-production does the response
  // itself include err.message, to keep local/staging debugging fast.
  // AppErrors (handled above) don't reach here — this is specifically
  // for the unexpected case, which is what's worth logging in full and
  // sending to Sentry. reportError does both (console + optional
  // Sentry); no separate console.error needed alongside it.
  c.executionCtx.waitUntil(reportError(c.env, err, { tags: { area: "http", path: c.req.path, requestId } }));
  const message = isProd(c.env) ? "internal server error" : err.message;
  return apiError(c, 500, "INTERNAL_ERROR", message);
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
      // system_context: this is the one legitimate place the Worker
      // enumerates every tenant rather than acting for one — nothing
      // client-triggered can reach this code path (it only runs on the
      // cron schedule in wrangler.toml), so it's safe to grant it the
      // cross-tenant read RLS would otherwise refuse. See
      // security/tenantContext.ts for the rest of this scheme.
      await setPrivilegedContext(sql, { system: true });
      const tenants = await listAllTenants(sql, 1000, 0);
      for (const tenant of tenants) {
        try {
          // Narrow back down to just this tenant for the actual sweep
          // work. Redundant on top of system_context (which alone would
          // already let every query through) but cheap, and it means a
          // bug inside detectMissingInvoices gets exactly the same
          // database-level backstop a normal authenticated request would
          // have, instead of running with a blanket cross-tenant bypass
          // for the length of the whole sweep.
          await setTenantContext(sql, tenant.tenantId);
          const result = await detectMissingInvoices(sql, tenant.tenantId);
          if (result.anomaliesCreated > 0) {
            console.log("scheduled_missing_invoice_sweep", { tenantId: tenant.tenantId, ...result });
          }
        } catch (e) {
          ctx.waitUntil(reportError(env, e, { severity: "warning", tags: { area: "cron", job: "missing_invoice_sweep", tenantId: tenant.tenantId } }));
        }
      }

      // Retention purge — src/purge.ts holds the actual logic; this is
      // the only place it's invoked on a schedule (routes/admin.ts's
      // purge-now endpoint invokes purgeTenantNow directly for an
      // immediate, single-tenant, admin-forced case). Runs after the
      // sweep above under the same system_context already set for this
      // whole scheduled() invocation.
      try {
        const summary = await runRetentionSweep(sql, env);
        console.log("scheduled_retention_sweep", summary);
        // A summary with failures logs OK overall (the sweep itself
        // didn't crash) but is worth a lower-severity report so a
        // creeping pile of un-purgeable tenants/documents doesn't go
        // unnoticed indefinitely.
        if (summary.documentsFailed > 0 || summary.tenantsFailed > 0) {
          ctx.waitUntil(reportError(env, new Error("retention sweep had per-item failures"), { severity: "warning", tags: { area: "cron", job: "retention_sweep" }, extra: { ...summary } }));
        }
      } catch (e) {
        ctx.waitUntil(reportError(env, e, { tags: { area: "cron", job: "retention_sweep" } }));
      }
    } finally {
      ctx.waitUntil(sql.end());
    }
  },
};
