// Razorpay: create a checkout order, and verify the two signatures it produces.
// Money rules this file exists to enforce:
//  * the amount is decided by OUR server (planPricesInr), never accepted from a client;
//  * nothing is trusted until its HMAC signature verifies (constant-time compare);
//  * secrets never leave the Worker.
import type { Env } from "../config";

const enc = new TextEncoder();

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function verifyHmacHex(secret: string, message: string, signatureHex: string | null | undefined): Promise<boolean> {
  if (!secret || !signatureHex) return false;
  const sig = hexToBytes(signatureHex.trim());
  if (!sig) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig, enc.encode(message)); // constant-time
}

/** Checkout success callback from the browser: HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
export function verifyCheckoutSignature(keySecret: string, orderId: string, paymentId: string, signature: string): Promise<boolean> {
  return verifyHmacHex(keySecret, `${orderId}|${paymentId}`, signature);
}

/** Webhook: HMAC_SHA256(raw request body, webhook_secret) in X-Razorpay-Signature. */
export function verifyWebhookSignature(webhookSecret: string, rawBody: string, signature: string | null | undefined): Promise<boolean> {
  return verifyHmacHex(webhookSecret, rawBody, signature);
}

export interface RazorpayOrder { id: string; amount: number; currency: string }

export async function createRazorpayOrder(
  env: Pick<Env, "RAZORPAY_KEY_ID" | "RAZORPAY_KEY_SECRET">,
  args: { amountPaise: number; receipt: string; notes: Record<string, string> },
  fetchImpl: typeof fetch = fetch,
): Promise<RazorpayOrder> {
  const resp = await fetchImpl("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)}`,
    },
    body: JSON.stringify({ amount: args.amountPaise, currency: "INR", receipt: args.receipt.slice(0, 40), notes: args.notes }),
  });
  const body = (await resp.json().catch(() => ({}))) as Partial<RazorpayOrder> & { error?: { description?: string } };
  if (!resp.ok || typeof body.id !== "string" || body.amount !== args.amountPaise || body.currency !== "INR") {
    // The provider's message goes to the logs by the caller; the user just gets "try again".
    throw new Error(`razorpay order creation failed: HTTP ${resp.status} ${body.error?.description ?? "unexpected response"}`);
  }
  return { id: body.id, amount: body.amount, currency: body.currency };
}

export interface RazorpayPayment { id: string; order_id: string; amount: number; currency: string; status: string }

/**
 * Ask Razorpay what really happened to a payment. Used when the browser says
 * "I paid": a signed browser callback proves the payment belongs to the order,
 * but not that the money was captured (with manual capture it can be merely
 * "authorized" and later reversed) — so we confirm with the provider itself
 * before giving anything away.
 */
export async function fetchRazorpayPayment(
  env: Pick<Env, "RAZORPAY_KEY_ID" | "RAZORPAY_KEY_SECRET">,
  paymentId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RazorpayPayment> {
  const resp = await fetchImpl(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Basic ${btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)}` },
  });
  const body = (await resp.json().catch(() => ({}))) as Partial<RazorpayPayment>;
  if (!resp.ok || body.id !== paymentId || typeof body.order_id !== "string" || typeof body.amount !== "number" || typeof body.status !== "string") {
    throw new Error(`razorpay payment lookup failed: HTTP ${resp.status}`);
  }
  return { id: body.id, order_id: body.order_id, amount: body.amount, currency: String(body.currency), status: body.status };
}
