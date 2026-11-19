import { emit } from "../observability/events";
import { Hono, type Context } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { hmacSha256Hex, timingSafeEqual } from "../lib_razorpay_sig";
import { applyPaidPlan, checkRazorpayConfig } from "../billing/razorpayPlan";

import { upiRoutes } from "./upi";
import { PLANS, isPlanId, type PlanId } from "../billing/plans";
export { PLANS };

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 10000,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

type BillingCtx = Context<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>;
export const billingRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

billingRoutes.use("*", requireAuth);
billingRoutes.route("/upi", upiRoutes); // backup payments — see routes/upi.ts

billingRoutes.get("/usage", async (c) => {
  const tenant = c.get("tenant");
  return c.json({
    tenantId: tenant.tenantId,
    planTier: tenant.planTier,
    usage: {
      documentsUploaded: 0,
      activeMembers: 1,
      reconciliationsThisMonth: 0,
    },
  });
});

// Owner diagnostic: is Razorpay configured on this Worker, with live keys that Razorpay accepts, and is the webhook secret set? (booleans only, no secrets)
billingRoutes.get("/config-check", async (c) => c.json(await checkRazorpayConfig(c.env)));

// ─── Razorpay: Create Order ───────────────────────────────
export const createOrderHandler = async (c: BillingCtx) => {
  const tenant = c.get("tenant");

  if (!c.env.RAZORPAY_KEY_ID || !c.env.RAZORPAY_KEY_SECRET) {
    console.error("razorpay:missing_credentials", {
      hasKeyId: !!c.env.RAZORPAY_KEY_ID,
      hasKeySecret: !!c.env.RAZORPAY_KEY_SECRET,
    });
    return c.json({ error: "Razorpay is not configured" }, 500);
  }

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!isPlanId(body?.plan)) {
    return c.json({ error: "plan must be one of: starter, pro, enterprise" }, 400);
  }
  const planId: PlanId = body.plan;
  emit("payment", { outcome: "order_requested", plan: planId });
  const amount = PLANS[planId].priceInr;
  const currency = "INR";

  // Razorpay rejects receipts longer than 40 chars — the old `order_<uuid>_<ts>` was 56.
  const receipt = `mp_${tenant.tenantId.slice(0, 8)}_${Date.now().toString(36)}`;
  const auth = btoa(`${c.env.RAZORPAY_KEY_ID}:${c.env.RAZORPAY_KEY_SECRET}`);

  try {
    const rzpRes = await fetchWithTimeout(
      "https://api.razorpay.com/v1/orders",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: amount * 100,
          currency,
          receipt,
          notes: {
            tenantId: tenant.tenantId,
            plan: planId,
          },
        }),
      },
      10000,
    );

    const order = (await rzpRes.json()) as {
      id: string; amount: number; currency: string; receipt: string; status: string;
      error?: { description?: string };
    };

    if (!rzpRes.ok) {
      console.error("razorpay:create_order_error", order);
      return c.json(
        {
          error: order.error?.description || "Failed to create order",
        },
        502,
      );
    }

    return c.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      status: order.status,
      keyId: c.env.RAZORPAY_KEY_ID,
    });
  } catch (e) {
    console.error("razorpay:create_order_exception", e);
    return c.json({ error: e instanceof Error ? e.message : "Failed to create Razorpay order" }, 500);
  }
};
billingRoutes.post("/create-order", createOrderHandler);

// ─── Razorpay: Verify Payment ───────���─────────────────────
export const verifyPaymentHandler = async (c: BillingCtx) => {
  const tenant = c.get("tenant");

  if (!c.env.RAZORPAY_KEY_SECRET || !c.env.RAZORPAY_KEY_ID) {
    console.error("razorpay:missing_verification_secret");
    return c.json({ error: "Razorpay is not configured" }, 500);
  }

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return c.json(
      {
        error: "razorpay_order_id, razorpay_payment_id, and razorpay_signature are required",
      },
      400,
    );
  }

  const text = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expected = await hmacSha256Hex(c.env.RAZORPAY_KEY_SECRET, text);
  if (!timingSafeEqual(expected, String(razorpay_signature))) {
    emit("payment", { outcome: "bad_signature" });
    return c.json({ error: "Signature mismatch" }, 400);
  }

  // A valid signature only proves Razorpay issued this order/payment pair — NOT that
  // it belongs to this tenant or paid the right amount. Re-fetch the order from
  // Razorpay (source of truth) and check owner, status, currency and amount.
  let order: { id: string; status: string; amount: number; amount_paid?: number; currency: string; notes?: Record<string, string> };
  try {
    const auth = btoa(`${c.env.RAZORPAY_KEY_ID}:${c.env.RAZORPAY_KEY_SECRET}`);
    const r = await fetchWithTimeout(`https://api.razorpay.com/v1/orders/${encodeURIComponent(String(razorpay_order_id))}`, { headers: { Authorization: `Basic ${auth}` } }, 10000);
    if (!r.ok) { emit("payment", { outcome: "gateway_error" }); return c.json({ error: "Could not confirm the order with Razorpay" }, 502); }
    order = (await r.json()) as typeof order;
  } catch (e) {
    console.error("razorpay:order_fetch_failed", (e as Error).message);
    return c.json({ error: "Could not confirm the order with Razorpay" }, 502);
  }
  const planId = order.notes?.plan;
  if (order.notes?.tenantId !== tenant.tenantId || !isPlanId(planId)) {
    console.error("razorpay:order_owner_mismatch", { orderId: order.id, tenantId: tenant.tenantId });
    emit("payment", { outcome: "owner_mismatch" });
    return c.json({ error: "This order does not belong to your account" }, 403);
  }
  if (order.status !== "paid" || order.currency !== "INR" || order.amount !== PLANS[planId].priceInr * 100 || (order.amount_paid ?? order.amount) !== order.amount) {
    // status "attempted" with a successful checkout usually means the Razorpay account is on MANUAL capture (payment authorised, not
    // captured) — Razorpay auto-refunds those after a while. Turn on auto-capture in the Razorpay dashboard (Settings → Payment capture).
    console.error("razorpay:order_not_paid", { orderId: order.id, orderStatus: order.status, amount: order.amount, amountPaid: order.amount_paid });
    emit("payment", { outcome: "not_paid" });
    return c.json({ error: "Payment not completed for the full plan amount" }, 402);
  }

  // Idempotent and race-safe: the same payment can be verified (or retried) any number of times, and the webhook may be applying
  // it at the same moment — see billing/razorpayPlan.ts.
  const sql = c.get("sql");
  const applied = await applyPaidPlan(sql, { tenantId: tenant.tenantId, planId, paymentId: String(razorpay_payment_id), orderId: order.id, source: "verify" });
  if (applied.status === "no_tenant") return c.json({ error: "Account not found" }, 404);
  console.log("razorpay:payment_verified", { orderId: order.id, paymentId: razorpay_payment_id, tenantId: tenant.tenantId, planTier: applied.planTier, result: applied.status });

  emit("payment", { outcome: "verified", plan: planId });
  return c.json({ status: "verified", orderId: order.id, paymentId: razorpay_payment_id, planTier: applied.planTier });
};
billingRoutes.post("/verify-payment", verifyPaymentHandler);
