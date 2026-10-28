import { hmacSha256Hex, timingSafeEqual } from "./lib_razorpay_sig";
import { Hono } from "hono";
import type { Env } from "./config";
import type { Sql } from "./db";
import type { TenantContext } from "./auth/supabase";
import { withDb } from "./middleware/db";
import { publicConfigRoutes } from "./routes/publicConfig";
import { telemetry, telemetryRoutes } from "./observability/telemetry";
import { emit } from "./observability/events";
import { requestId, securityHeaders, corsMiddleware, requestSizeLimit } from "./middleware/security";
import { rateLimit, isolateRateLimit } from "./middleware/rateLimit";
import { ValidationError } from "./security/validate";
import { claimOnce } from "./ratelimit";
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
import { billingRoutes } from "./routes/billing";
import { webhookRoutes } from "./routes/webhooks";
import { handleQueueBatch } from "./queue/consumer";
import { getDb } from "./db";
import { listAllTenants } from "./repository/tenants";
import { detectMissingInvoices } from "./pipelines/missingInvoice";

export const app = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

app.use("*", requestId, telemetry, securityHeaders, corsMiddleware(), requestSizeLimit);
// Abuse controls (before any DB work): generous per-IP ceiling everywhere,
// tighter on public/unauthenticated and money endpoints.
app.use("/api/*", isolateRateLimit(600, 60));
app.use("/api/v1/roi/*", rateLimit("roi", 20, 60));
app.use("/api/v1/billing/*", rateLimit("billing", 30, 60, { failClosed: true }));
app.use("/webhook/*", rateLimit("webhook", 300, 60));
app.use("/api/razorpay/*", rateLimit("rzp-webhook", 300, 60));
app.use("*", withDb);

// health check sits outside /api/v1, same as the Go router
app.route("/", healthRoutes);

app.use("/api/v1/telemetry", isolateRateLimit(120, 60));
app.route("/api/v1/telemetry", telemetryRoutes);
app.route("/api/v1/config", publicConfigRoutes);
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

// ─── Razorpay: Webhook Handler ────────────────────────────
app.post("/api/razorpay/webhook", async (c) => {
  const body = await c.req.text();
  const signature = c.req.header("X-Razorpay-Signature");

  if (!c.env.RAZORPAY_WEBHOOK_SECRET) {
    console.error("RAZORPAY_WEBHOOK_SECRET not configured");
    return c.json({ error: "Webhook secret not configured" }, 500);
  }

  const expected = await hmacSha256Hex(c.env.RAZORPAY_WEBHOOK_SECRET, body);
  if (!signature || !timingSafeEqual(expected, signature)) {
    emit("webhook_rejected", { reason: "bad_signature", source: "razorpay" });
    return c.json({ error: "Invalid signature" }, 400);
  }

  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  // Replay / duplicate-delivery guard: process each Razorpay event id once.
  const eventId = c.req.header("X-Razorpay-Event-Id");
  if (eventId && /^[A-Za-z0-9_-]{6,80}$/.test(eventId)) {
    try {
      if (!(await claimOnce(c.env, `rzp:${eventId}`))) return c.json({ status: "duplicate" }, 200);
    } catch (e) {
      console.error("webhook_dedupe_unavailable", (e as Error).message); // still process; handler is idempotent (log-only today)
    }
  }

  switch (event.event) {
    case "payment.captured":
      console.log("razorpay:payment_captured", event.payload?.payment?.entity?.id);
      break;
    case "payment.failed":
      console.log("razorpay:payment_failed", event.payload?.payment?.entity?.id);
      break;
    case "order.paid":
      console.log("razorpay:order_paid", event.payload?.order?.entity?.id);
      break;
    case "refund.processed":
      console.log("razorpay:refund_processed", event.payload?.refund?.entity?.id);
      break;
    default:
      console.log("razorpay:event", event.event);
  }

  return c.json({ status: "ok" }, 200);
});

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  if (err instanceof ValidationError) return c.json({ error: err.message, field: err.field }, 422);
  // Never leak stack traces / SQL / internals to the client; correlate via request id.
  console.error("unhandled_error", { requestId: c.get("requestId" as never), path: c.req.path, error: err.message });
  return c.json({ error: "internal server error", requestId: c.get("requestId" as never) }, 500);
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
