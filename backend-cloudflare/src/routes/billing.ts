import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";

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

export const billingRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();

billingRoutes.use("*", requireAuth);

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

// ─── Razorpay: Create Order ───────────────────────────────
billingRoutes.post("/create-order", async (c) => {
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

  const amount = parseInt(body.amount, 10);
  const currency = body.currency || "INR";

  if (!amount || amount < 1) {
    return c.json({ error: "amount is required and must be a positive integer" }, 400);
  }

  const receipt = `order_${tenant.tenantId}_${Date.now()}`;
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
            planTier: tenant.planTier,
          },
        }),
      },
      10000,
    );

    const order = await rzpRes.json();

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
});

// ─── Razorpay: Verify Payment ───────���─────────────────────
billingRoutes.post("/verify-payment", async (c) => {
  const tenant = c.get("tenant");

  if (!c.env.RAZORPAY_KEY_SECRET) {
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
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(c.env.RAZORPAY_KEY_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));

  if (expected !== razorpay_signature) {
    return c.json({ error: "Signature mismatch" }, 400);
  }

  console.log("razorpay:payment_verified", {
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
    tenantId: tenant.tenantId,
  });

  return c.json({
    status: "verified",
    orderId: razorpay_order_id,
    paymentId: razorpay_payment_id,
  });
});
