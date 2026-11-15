import { Hono, type Context } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { invalidateTenantCache } from "../auth/supabase";
import { emit } from "../observability/events";
import { rateLimit } from "../middleware/rateLimit";
import { PLANS, isPlanId } from "../billing/plans";
import { buildUpiIntent, createGatewayOrder, getGatewayOrder, GatewayError, isValidUtr, newReference, upiMode, verifyUpiGatewaySignature } from "../billing/upi";
import { appendAuditLog } from "../repository/auditLog";
import {
  countOpenUpiPayments, createUpiPayment, getUpiPaymentById, getUpiPaymentByReference, getUpiPaymentForTenant, listUpiPayments, markUpiExpired,
  rejectUpiPayment, setGatewayOrder, settleAndUpgrade, submitUtr, type UpiPayment, type UpiStatus,
} from "../repository/upiPayments";
import { claimWebhookEvent, releaseWebhookEvent } from "../repository/webhookEvents";

type Ctx = Context<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>;
const MAX_OPEN = 3;

// Mounted under /api/v1/billing/upi — requireAuth is inherited from billingRoutes.
export const upiRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

const publicView = (p: UpiPayment, extra: Record<string, unknown> = {}) => ({ paymentId: p.paymentId, plan: p.plan, amountInr: p.amountInr, reference: p.reference, mode: p.mode, status: p.status, expiresAt: p.expiresAt, ...extra });

async function upgradeAudit(sql: Sql, p: UpiPayment, r: Awaited<ReturnType<typeof settleAndUpgrade>>, who: string, tenantEmail: string) {
  if (r.alreadyDone || !r.tenantId) return;
  invalidateTenantCache(r.tenantId);
  emit("payment", { outcome: "upi_verified", plan: p.plan, mode: p.mode });
  try {
    await appendAuditLog(sql, { tenantId: r.tenantId, entityType: "TENANT", entityId: r.tenantId, action: "PLAN_UPGRADED", fieldName: "plan_tier", oldValue: r.oldTier, newValue: r.newTier,
      reason: `upi payment ${p.reference} (${p.mode})${p.utr ? ` utr ${p.utr}` : ""}${r.upgraded ? "" : " (no downgrade applied)"} — confirmed by ${who}`, actorEmail: tenantEmail });
  } catch (e) { console.error(JSON.stringify({ level: "error", msg: "upi_audit_failed", paymentId: p.paymentId, error: (e as Error).message })); } // the plan is already applied; never undo it over a log write
}

upiRoutes.get("/config", (c) => {
  const mode = upiMode(c.env);
  return c.json({ enabled: mode !== null, mode, payeeName: mode === "manual" ? (c.env.UPI_PAYEE_NAME || "MarginPulse") : undefined });
});

upiRoutes.post("/orders", rateLimit("upi-order", 10, 3600), async (c: Ctx) => {
  const mode = upiMode(c.env);
  if (!mode) return c.json({ error: "UPI payment is not available right now" }, 404);
  const body = await c.req.json().catch(() => null) as { plan?: unknown } | null;
  if (!isPlanId(body?.plan)) return c.json({ error: "plan must be one of: starter, pro, enterprise" }, 400);
  const plan = body!.plan as keyof typeof PLANS;
  const tenant = c.get("tenant"), sql = c.get("sql");
  if (await countOpenUpiPayments(sql, tenant.tenantId) >= MAX_OPEN) return c.json({ error: "You already have open UPI payments. Finish or wait for them to expire before starting another." }, 429);

  const amountInr = PLANS[plan].priceInr; // the server decides the price
  const p = await createUpiPayment(sql, { tenantId: tenant.tenantId, plan, amountInr, reference: newReference(), mode, expiresInMinutes: mode === "gateway" ? 30 : 24 * 60 });
  emit("payment", { outcome: "upi_order_created", plan, mode });

  if (mode === "manual") {
    const intent = buildUpiIntent({ vpa: c.env.UPI_VPA!, payeeName: c.env.UPI_PAYEE_NAME || "MarginPulse", amountInr, reference: p.reference, note: `MarginPulse ${plan}` });
    return c.json(publicView(p, { upiIntent: intent, vpa: c.env.UPI_VPA, payeeName: c.env.UPI_PAYEE_NAME || "MarginPulse",
      instructions: "Pay the exact amount in any UPI app, then enter the 12-digit UTR/reference from the payment screen. Your plan is activated after we confirm the credit." }), 201);
  }
  try {
    const g = await createGatewayOrder(c.env, { amountInr, clientOrderId: p.reference });
    if (!g.live && c.env.ENVIRONMENT === "production") throw new GatewayError(false, "gateway returned a non-live order");
    await setGatewayOrder(sql, p.paymentId, g.orderId);
    return c.json(publicView({ ...p, gatewayOrderId: g.orderId }, { paymentUrl: g.paymentUrl, upiIntent: g.upiIntent }), 201);
  } catch (e) {
    await markUpiExpired(sql, p.paymentId).catch(() => {});
    const retryable = e instanceof GatewayError ? e.retryable : true;
    emit("payment", { outcome: "upi_gateway_error", mode });
    console.error(JSON.stringify({ level: "error", msg: "upi_gateway_create_failed", error: (e as Error).message, retryable }));
    return c.json({ error: "The UPI gateway is not reachable right now. You have not been charged — please try again in a minute.", retryable }, 502);
  }
});

upiRoutes.post("/orders/:id/utr", rateLimit("upi-utr", 10, 3600), async (c: Ctx) => {
  const tenant = c.get("tenant"), sql = c.get("sql");
  const body = await c.req.json().catch(() => null) as { utr?: unknown } | null;
  const utr = typeof body?.utr === "string" ? body.utr.trim() : "";
  if (!isValidUtr(utr)) return c.json({ error: "Enter the 12-digit UTR / UPI reference number from your payment" }, 400);
  const p = await getUpiPaymentForTenant(sql, tenant.tenantId, c.req.param("id")!);
  if (!p) return c.json({ error: "payment not found" }, 404);
  if (p.mode !== "manual") return c.json({ error: "This payment is confirmed automatically — no UTR needed" }, 409);
  const r = await submitUtr(sql, tenant.tenantId, p.paymentId, utr);
  if (r === "used") { emit("payment", { outcome: "upi_utr_reused" }); return c.json({ error: "That UTR has already been used for another payment" }, 409); }
  if (r === "not_open") return c.json({ error: "This payment can no longer accept a UTR (already submitted, decided or expired)" }, 409);
  emit("payment", { outcome: "upi_utr_submitted", plan: p.plan });
  return c.json({ status: "SUBMITTED", message: "Thanks — we'll check our bank credit and activate your plan, usually within a few working hours." });
});

upiRoutes.get("/orders/:id", async (c: Ctx) => {
  const tenant = c.get("tenant"), sql = c.get("sql");
  let p = await getUpiPaymentForTenant(sql, tenant.tenantId, c.req.param("id")!);
  if (!p) return c.json({ error: "payment not found" }, 404);
  let gatewayCheck: "ok" | "unavailable" | undefined;
  if (p.mode === "gateway" && p.status === "PENDING" && p.gatewayOrderId) {
    // Source of truth is the gateway: poll it, so a lost/late webhook never leaves a paid customer waiting.
    try {
      const g = await getGatewayOrder(c.env, p.gatewayOrderId);
      gatewayCheck = "ok";
      if (g.status === "paid" && g.clientOrderId === p.reference && g.amountInr === p.amountInr && (g.live || c.env.ENVIRONMENT !== "production")) {
        const r = await settleAndUpgrade(sql, p.paymentId, "upi-gateway (poll)");
        await upgradeAudit(sql, p, r, "upi-gateway", tenant.ownerEmail);
      } else if (g.status === "expired" || new Date(p.expiresAt).getTime() < Date.now()) await markUpiExpired(sql, p.paymentId);
    } catch (e) {
      gatewayCheck = "unavailable";
      console.warn(JSON.stringify({ level: "warn", msg: "upi_gateway_poll_failed", error: (e as Error).message }));
    }
    p = (await getUpiPaymentForTenant(sql, tenant.tenantId, p.paymentId)) ?? p;
  }
  return c.json(publicView(p, { gatewayCheck }));
});

// ── platform admin: review manual payments (mounted at /api/v1/admin/upi-payments; auth + admin check inherited) ──
export const upiAdminRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();
const STATUSES = new Set(["PENDING", "SUBMITTED", "PAID", "REJECTED", "EXPIRED"]);

upiAdminRoutes.get("/", async (c) => {
  const status = (c.req.query("status") ?? "SUBMITTED").toUpperCase();
  if (!STATUSES.has(status)) return c.json({ error: "invalid status" }, 400);
  return c.json({ payments: await listUpiPayments(c.get("sql"), status as UpiStatus, Number(c.req.query("limit")) || 100) });
});

upiAdminRoutes.post("/:id/approve", async (c) => {
  const sql = c.get("sql"), admin = c.get("tenant");
  const p = await getUpiPaymentById(sql, c.req.param("id")!);
  if (!p) return c.json({ error: "payment not found" }, 404);
  if (p.mode !== "manual") return c.json({ error: "Gateway payments are confirmed by the gateway, not manually" }, 409);
  if (p.status !== "SUBMITTED" || !p.utr) return c.json({ error: `Only a payment with a submitted UTR can be approved (status: ${p.status})` }, 409);
  const r = await settleAndUpgrade(sql, p.paymentId, admin.ownerEmail);
  if (r.alreadyDone) return c.json({ status: "already_decided" });
  const tenantRow = await sql<{ ownerEmail: string }[]>`select owner_email as "ownerEmail" from tenants where tenant_id = ${p.tenantId}`;
  await upgradeAudit(sql, p, r, admin.ownerEmail, tenantRow[0]?.ownerEmail ?? admin.ownerEmail);
  return c.json({ status: "approved", planTier: r.newTier });
});

upiAdminRoutes.post("/:id/reject", async (c) => {
  const sql = c.get("sql"), admin = c.get("tenant");
  const p = await getUpiPaymentById(sql, c.req.param("id")!);
  if (!p) return c.json({ error: "payment not found" }, 404);
  if (p.mode !== "manual") return c.json({ error: "Gateway payments are decided by the gateway" }, 409);
  const ok = await rejectUpiPayment(sql, p.paymentId, admin.ownerEmail);
  if (ok) emit("payment", { outcome: "upi_rejected" });
  return c.json({ status: ok ? "rejected" : "already_decided" });
});

// ── upi-gateway webhook (POST /webhook/upi-gateway) ───────────────────────
// Signed `t=<unix>,v1=<hmac of "t.rawBody">`, ±300 s. Delivery is at-least-once and may be out of order, so: dedupe on event_id,
// and let the atomic PENDING/SUBMITTED→PAID flip make "paid" idempotent. Sandbox events never upgrade a plan in production.
export async function upiGatewayWebhook(c: Context<{ Bindings: Env; Variables: { sql: Sql } }>) {
  if (!c.env.UPI_GATEWAY_WEBHOOK_SECRET) return c.json({ error: "webhook not configured" }, 503);
  const raw = await c.req.text();
  const sig = await verifyUpiGatewaySignature(c.env.UPI_GATEWAY_WEBHOOK_SECRET, raw, c.req.header("X-Signature"));
  if (!sig.ok) { emit("webhook_rejected", { reason: sig.reason, source: "upi_gateway" }); return c.json({ error: "Invalid signature" }, 401); }

  let ev: { event_id?: unknown; event?: unknown; data?: { order_id?: unknown; client_order_id?: unknown; amount?: unknown; status?: unknown; environment?: unknown; test?: unknown } };
  try { ev = JSON.parse(raw); } catch { return c.json({ error: "invalid json" }, 400); }
  const eventId = typeof ev.event_id === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(ev.event_id) ? ev.event_id : null;
  if (!eventId || typeof ev.event !== "string") return c.json({ error: "event_id and event are required" }, 400);

  const sql = c.get("sql");
  if (!(await claimWebhookEvent(sql, "upi_gateway", eventId))) return c.json({ status: "duplicate" });
  try {
    const d = ev.data ?? {};
    const isTest = d.test === true || String(d.environment ?? "live").toLowerCase() !== "live";
    if (isTest && c.env.ENVIRONMENT === "production") return c.json({ status: "ignored_test_event" });
    const ref = typeof d.client_order_id === "string" ? d.client_order_id : "";
    const p = ref ? await getUpiPaymentByReference(sql, ref) : null;
    if (!p || p.mode !== "gateway") { console.warn(JSON.stringify({ level: "warn", msg: "upi_webhook_unknown_order", event: ev.event })); return c.json({ status: "unknown_order" }); } // 200: retrying can't help

    if (ev.event === "order.paid") {
      const amountOk = Number(d.amount) === p.amountInr, orderOk = !p.gatewayOrderId || p.gatewayOrderId === d.order_id;
      if (!amountOk || !orderOk) {
        emit("payment", { outcome: "upi_mismatch" });
        console.error(JSON.stringify({ level: "error", msg: "upi_webhook_mismatch", paymentId: p.paymentId, amountOk, orderOk }));
        return c.json({ status: "mismatch_ignored" });
      }
      const r = await settleAndUpgrade(sql, p.paymentId, "upi-gateway (webhook)");
      const owner = await sql<{ ownerEmail: string }[]>`select owner_email as "ownerEmail" from tenants where tenant_id = ${p.tenantId}`;
      await upgradeAudit(sql, p, r, "upi-gateway", owner[0]?.ownerEmail ?? "system");
      return c.json({ status: r.alreadyDone ? "already_paid" : "ok" });
    }
    if (ev.event === "order.expired") await markUpiExpired(sql, p.paymentId); // never touches a PAID row
    return c.json({ status: "ok" });
  } catch (e) {
    await releaseWebhookEvent(sql, "upi_gateway", eventId).catch(() => {}); // let the gateway's retry process it
    emit("webhook_rejected", { reason: "processing_error", source: "upi_gateway" });
    console.error(JSON.stringify({ level: "error", msg: "upi_webhook_failed", eventId, error: (e as Error).message }));
    return c.json({ error: "temporarily unable to process" }, 500);
  }
}
