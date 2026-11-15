import { hmacSha256Hex, timingSafeEqual } from "./lib_razorpay_sig";
import { Hono } from "hono";
import type { Env } from "./config";
import type { Sql } from "./db";
import type { TenantContext } from "./auth/supabase";
import { withDb } from "./middleware/db";
import { publicConfigRoutes } from "./routes/publicConfig";
import { telemetry, telemetryRoutes } from "./observability/telemetry";
import { emit, registry, setSink } from "./observability/events";
import { flushPending } from "./observability/metrics";
import { requestId, securityHeaders, corsMiddleware, requestSizeLimit } from "./middleware/security";
import { rateLimit, isolateRateLimit } from "./middleware/rateLimit";
import { ValidationError } from "./security/validate";
import { shedHeavy } from "./middleware/shed";
import { isDbUnavailable, retryAfterSeconds } from "./lib/dbErrors";
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
import { trackRoutes } from "./routes/track";
import { purgeOldVisitors } from "./repository/visitors";
import { handleQueueBatch } from "./queue/consumer";
import { getDb } from "./db";
import { listMissingInvoiceCandidateTenants } from "./repository/bankTransactions";
import { detectMissingInvoices } from "./pipelines/missingInvoice";

export const app = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

app.use("*", requestId, telemetry, securityHeaders, corsMiddleware(), requestSizeLimit);
// Abuse controls (before any DB work): generous per-IP ceiling everywhere,
// tighter on public/unauthenticated and money endpoints.
app.use("/api/*", isolateRateLimit(6000, 60));
app.use("/api/v1/roi/*", rateLimit("roi", 20, 60));
// Payments must not depend on Redis being up: the zero-latency per-isolate limiter is the always-on backstop and the
// Upstash limiter (1.5 s timeout) adds global limits; if Redis is down we fail OPEN and count it (ratelimit_backend_error).
app.use("/api/v1/billing/*", isolateRateLimit(30, 60), rateLimit("billing", 30, 60));
app.use("/api/v1/track/*", isolateRateLimit(30, 60), rateLimit("track", 30, 60));
app.use("/webhook/*", rateLimit("webhook", 300, 60));
app.use("/api/razorpay/*", rateLimit("rzp-webhook", 300, 60));
// Load shedding for the expensive endpoints, BEFORE any auth/DB work: refuse the excess in microseconds with 503 + Retry-After.
app.use("/api/v1/documents/upload", shedHeavy("upload"));
app.use("/api/v1/reconciliation/dataset-upload", shedHeavy("dataset_upload"));
app.use("/api/v1/reconciliation/run", shedHeavy("reconcile_run"));
app.use("/api/v1/reconciliation/export", shedHeavy("export"));
app.use("*", withDb);

// health check sits outside /api/v1, same as the Go router
app.route("/", healthRoutes);

app.use("/api/v1/telemetry", isolateRateLimit(120, 60));
app.route("/api/v1/telemetry", telemetryRoutes);
app.route("/api/v1/track", trackRoutes); // public + credential-less + consent-gated — see routes/track.ts
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
  // Database overloaded / unreachable (pool exhausted, connect timeout, failover): that is "retry shortly", not a bug.
  if (isDbUnavailable(err)) {
    const wait = retryAfterSeconds();
    emit("db_unavailable", { path: "api" });
    console.error(JSON.stringify({ level: "error", msg: "db_unavailable", requestId: c.get("requestId" as never), path: c.req.path, code: (err as { code?: string }).code, error: err.message }));
    c.header("Retry-After", String(wait));
    return c.json({ error: "The service is busy right now. Please retry in a few seconds.", code: "BUSY", retryable: true, retryAfterSeconds: wait, requestId: c.get("requestId" as never) }, 503);
  }
  // Never leak stack traces / SQL / internals to the client; correlate via request id.
  console.error("unhandled_error", { requestId: c.get("requestId" as never), path: c.req.path, error: err.message });
  return c.json({ error: "internal server error", requestId: c.get("requestId" as never) }, 500);
});

export default {
  fetch: app.fetch,

  // Cloudflare Queues consumer — drains all 5 queues (wrangler.toml),
  // dispatching by the message's "task" field. See queue/consumer.ts.
  async queue(batch: MessageBatch, env: Env, ctx?: ExecutionContext): Promise<void> {
    setSink(env);
    try { await handleQueueBatch(batch as MessageBatch<any>, env); }
    finally { const f = flushPending(registry, env); try { ctx?.waitUntil(f); } catch { void f; } } // no HTTP middleware runs in a queue isolate, so push metrics here
  },

  // Cron Trigger (wrangler.toml: daily at 03:00) — replaces the never-built EventBridge rule from ROADMAP.md.
  // Fans the daily missing-invoice detection OUT to the queue, one message per tenant that actually has candidate data
  // (an old unmatched debit and at least one vendor on file). It used to loop over the first 1000 tenants inside this one
  // invocation: tenants beyond 1000 were never checked, and a long loop would hit the cron's time/CPU limits.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    setSink(env);
    const sql = getDb(env);
    const t0 = Date.now();
    try {
      const cutoff = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10); // same "older than 5 days" rule as detectMissingInvoices
      const maxTenants = Number(env.CRON_MAX_TENANTS) || 200_000; // per run; a runaway query can never enqueue forever
      let after: string | null = null, enqueued = 0;
      for (;;) {
        const ids = await listMissingInvoiceCandidateTenants(sql, cutoff, after, 500);
        if (ids.length === 0) break;
        after = ids[ids.length - 1]!;
        if (env.RECONCILE_QUEUE) {
          for (let i = 0; i < ids.length; i += 100) { // Queues accept at most 100 messages per sendBatch
            await env.RECONCILE_QUEUE.sendBatch(ids.slice(i, i + 100).map((tenantId) => ({ body: { task: "detect_missing_invoices", job_id: crypto.randomUUID(), args: { tenant_id: tenantId } } })));
          }
        } else {
          // No queue bound (local/dev): run inline, but only a bounded number so this path can never stall a real cron.
          for (const tenantId of ids.slice(0, Math.max(0, 200 - enqueued))) {
            try { await detectMissingInvoices(sql, tenantId); } catch (e) { emit("cron_run", { outcome: "tenant_error" }); console.error("scheduled_sweep_failed_for_tenant", { tenantId, error: (e as Error).message }); }
          }
        }
        enqueued += ids.length;
        if (enqueued >= maxTenants) { console.warn(JSON.stringify({ level: "warn", msg: "cron_tenant_cap_reached", cap: maxTenants })); break; }
      }
      emit("cron_enqueued", { task: "missing_invoice" }, enqueued);
      // Retention: visitor rows older than VISITOR_RETENTION_DAYS (default 90) are deleted, so analytics never becomes an archive.
      try {
        const purged = await purgeOldVisitors(sql, Number(env.VISITOR_RETENTION_DAYS) || 90);
        if (purged > 0) console.log(JSON.stringify({ level: "info", msg: "visitors_purged", purged }));
      } catch (e) {
        emit("cron_run", { outcome: "purge_error" });
        console.error(JSON.stringify({ level: "error", msg: "visitor_purge_failed", error: (e as Error).message }));
      }
      emit("cron_run", { outcome: "ok" });
      registry.observe("marginpulse.cron.duration", "s", (Date.now() - t0) / 1000, { task: "daily_sweep" }); // NOT "job"/"instance": those collide with Prometheus's reserved target labels and the collector drops the whole metric
    } catch (e) {
      emit("cron_run", { outcome: "error" });
      console.error(JSON.stringify({ level: "error", msg: "cron_failed", error: (e as Error).message }));
      throw e; // let Cloudflare record the invocation as failed
    } finally {
      ctx.waitUntil(sql.end());
      ctx.waitUntil(flushPending(registry, env));
    }
  },
};
