import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { ensureMonthlyGrant, getWalletSummary, listLedger } from "../billing/credits";
import { listUsageEvents } from "../billing/usage";
import { rateLimit } from "../middleware/rateLimit";
import { apiError } from "../http";
import { reportError } from "../monitoring";
import {
  FEATURES, PLAN_LABELS, gatingEnforced, isPaidPlan, paymentsConfigured, planCatalog, planPricesInr, planRank,
} from "../billing/plans";
import { createRazorpayOrder, fetchRazorpayPayment, verifyCheckoutSignature } from "../billing/razorpay";
import { activatePaidOrder, currentPlanOf, insertPaymentOrder } from "../repository/payments";

export const billingRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext; requestId: string } }>();

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

// GET /billing/plans — everything the Plans/Pricing screen and the sidebar locks
// need in one call: the tenant's plan, the catalogue (prices only if configured),
// which feature needs which plan, and whether locking is switched on at all.
billingRoutes.get("/plans", (c) => {
  const tenant = c.get("tenant");
  return c.json({
    currentPlan: tenant.planTier,
    currentPlanLabel: PLAN_LABELS[tenant.planTier as keyof typeof PLAN_LABELS] ?? tenant.planTier,
    planExpiresAt: tenant.planExpiresAt ?? null,
    plans: planCatalog(c.env),
    features: Object.fromEntries(Object.entries(FEATURES).map(([k, f]) => [k, { label: f.label, minPlan: f.minPlan, minPlanLabel: PLAN_LABELS[f.minPlan] }])),
    gatingEnforced: gatingEnforced(c.env),
    paymentsEnabled: paymentsConfigured(c.env),
  });
});

// POST /billing/checkout  { plan }  — start a purchase. The amount is decided HERE
// from server config; the client only names a plan. Returns what Razorpay Checkout
// needs in the browser (the public key id, never the secret).
billingRoutes.post("/checkout", rateLimit("checkout", 6, 60), async (c) => {
  const tenant = c.get("tenant");
  const sql = c.get("sql");
  const requestId = c.get("requestId");

  let body: { plan?: unknown } = {};
  try { body = (await c.req.json()) as { plan?: unknown }; } catch { /* handled below */ }
  const plan = body.plan;
  if (!isPaidPlan(plan)) return apiError(c, 400, "VALIDATION_ERROR", "plan must be one of STARTER, GROWTH, ENTERPRISE");

  if (!paymentsConfigured(c.env)) return apiError(c, 501, "NOT_IMPLEMENTED", "online payments are not enabled yet");
  const priceInr = planPricesInr(c.env)[plan];
  if (priceInr === undefined) return apiError(c, 501, "NOT_IMPLEMENTED", "this plan is not available for purchase yet");

  // Don't let someone pay for a lower plan than the one they still have (renewing the same plan is fine).
  const current = await currentPlanOf(sql, tenant.tenantId);
  if (planRank(current) > planRank(plan)) {
    return apiError(c, 409, "CONFLICT", `You're already on ${PLAN_LABELS[current as keyof typeof PLAN_LABELS] ?? current}, which includes everything in ${PLAN_LABELS[plan]}`);
  }

  const amountPaise = priceInr * 100;
  let order;
  try {
    order = await createRazorpayOrder(c.env, {
      amountPaise, receipt: `mp_${tenant.tenantId.slice(0, 8)}_${Date.now()}`, notes: { tenant_id: tenant.tenantId, plan },
    });
  } catch (e) {
    c.executionCtx.waitUntil(reportError(c.env, e, { tags: { area: "payments", step: "create_order", requestId } }));
    return apiError(c, 502, "UPSTREAM_ERROR", "couldn't start the payment — please try again");
  }
  await insertPaymentOrder(sql, { tenantId: tenant.tenantId, plan, months: 1, amountPaise, razorpayOrderId: order.id });
  return c.json({
    keyId: c.env.RAZORPAY_KEY_ID, orderId: order.id, amount: order.amount, currency: order.currency,
    plan, planLabel: PLAN_LABELS[plan], email: tenant.ownerEmail,
  });
});

// POST /billing/verify  { razorpay_order_id, razorpay_payment_id, razorpay_signature }
// The browser says "payment done". We don't take its word for it: the signature
// must verify, and then we ask Razorpay whether that payment was really captured,
// for this order, for our amount. The webhook (routes/webhooks.ts) is the
// independent second path to the same idempotent activation.
const RZP_ID = /^[A-Za-z0-9_]{6,64}$/;
billingRoutes.post("/verify", rateLimit("verify_payment", 10, 60), async (c) => {
  const tenant = c.get("tenant");
  if (!paymentsConfigured(c.env)) return apiError(c, 501, "NOT_IMPLEMENTED", "online payments are not enabled yet");

  let b: Record<string, unknown> = {};
  try { b = (await c.req.json()) as Record<string, unknown>; } catch { /* handled below */ }
  const orderId = b.razorpay_order_id, paymentId = b.razorpay_payment_id, signature = b.razorpay_signature;
  if (typeof orderId !== "string" || typeof paymentId !== "string" || typeof signature !== "string" || !RZP_ID.test(orderId) || !RZP_ID.test(paymentId) || signature.length > 200) {
    return apiError(c, 400, "VALIDATION_ERROR", "invalid payment confirmation");
  }
  if (!(await verifyCheckoutSignature(c.env.RAZORPAY_KEY_SECRET!, orderId, paymentId, signature))) {
    console.warn("billing_verify_bad_signature", { tenantId: tenant.tenantId });
    return apiError(c, 400, "VALIDATION_ERROR", "payment could not be verified");
  }

  let payment;
  try {
    payment = await fetchRazorpayPayment(c.env, paymentId);
  } catch (e) {
    c.executionCtx.waitUntil(reportError(c.env, e, { tags: { area: "payments", step: "fetch_payment" } }));
    return c.json({ status: "PENDING", message: "Your payment is being confirmed — your plan will activate shortly." }, 202);
  }
  if (payment.order_id !== orderId) return apiError(c, 400, "VALIDATION_ERROR", "payment does not belong to this order");
  if (payment.status !== "captured") {
    return c.json({ status: "PENDING", message: "Your payment is being confirmed — your plan will activate shortly." }, 202);
  }

  const result = await activatePaidOrder(c.get("sql"), {
    razorpayOrderId: orderId, paymentId, amountPaise: payment.amount, currency: payment.currency, expectTenantId: tenant.tenantId,
  });
  switch (result.status) {
    case "ACTIVATED": return c.json({ status: "ACTIVE", plan: result.plan, planLabel: PLAN_LABELS[result.plan], planExpiresAt: result.expiresAt });
    case "ALREADY_PAID": return c.json({ status: "ACTIVE", message: "Your plan is already active." });
    case "AMOUNT_MISMATCH":
      console.error("billing_amount_mismatch", { tenantId: tenant.tenantId, orderId, paymentId });
      c.executionCtx.waitUntil(reportError(c.env, new Error("payment amount mismatch"), { tags: { area: "payments", orderId } }));
      return apiError(c, 409, "CONFLICT", "payment amount did not match the order — please contact support");
    default: return apiError(c, 404, "NOT_FOUND", "order not found");
  }
});

// The previous Billing page called these two routes. They let the BROWSER choose the
// price, verified payments incorrectly, and activated nothing — so a customer could
// pay and receive no plan. They are retired: anyone still running the old page gets
// a clear instruction instead of a checkout that takes money for nothing.
const RETIRED = "This billing screen is out of date. Please refresh the page (Ctrl/Cmd+Shift+R) and try again — you have not been charged.";
billingRoutes.post("/create-order", (c) => apiError(c, 410, "CONFLICT", RETIRED));
billingRoutes.post("/verify-payment", (c) => apiError(c, 410, "CONFLICT", RETIRED));
