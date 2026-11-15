import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUpiIntent, createGatewayOrder, GatewayError, getGatewayOrder, isValidUtr, isValidVpa, newReference, upiMode, verifyUpiGatewaySignature } from "../src/billing/upi.ts";
import { hmacSha256Hex } from "../src/lib_razorpay_sig.ts";

const GW = { UPI_FALLBACK_ENABLED: "true", UPI_GATEWAY_BASE_URL: "https://pay.example.com", UPI_GATEWAY_API_KEY: "k", UPI_GATEWAY_API_SECRET: "s", UPI_GATEWAY_WEBHOOK_SECRET: "w" };

test("upiMode: off by default, off when half-configured, manual with a VPA, gateway when fully configured", () => {
  assert.equal(upiMode({}), null);
  assert.equal(upiMode({ UPI_VPA: "mp@okhdfcbank" }), null, "a VPA alone must not switch the fallback on");
  assert.equal(upiMode({ UPI_FALLBACK_ENABLED: "true" }), null);
  assert.equal(upiMode({ UPI_FALLBACK_ENABLED: "true", UPI_VPA: "mp@okhdfcbank" }), "manual");
  assert.equal(upiMode({ UPI_FALLBACK_ENABLED: "true", UPI_VPA: "not a vpa" }), null);
  assert.equal(upiMode({ ...GW, UPI_GATEWAY_WEBHOOK_SECRET: "" }), null, "gateway without a webhook secret is unsafe → off");
  assert.equal(upiMode(GW), "gateway");
  assert.equal(upiMode({ ...GW, UPI_VPA: "mp@okhdfcbank" }), "gateway");
});

test("upi:// intent carries payee, exact amount, INR and our reference; bad input is refused", () => {
  const url = buildUpiIntent({ vpa: "marginpulse@okhdfcbank", payeeName: "MarginPulse Technologies", amountInr: 1499, reference: "MPABC123XYZ", note: "MarginPulse pro" });
  assert.ok(url.startsWith("upi://pay?"));
  const q = new URL(url.replace("upi://", "https://x/")).searchParams;
  assert.deepEqual([q.get("pa"), q.get("am"), q.get("cu"), q.get("tr")], ["marginpulse@okhdfcbank", "1499.00", "INR", "MPABC123XYZ"]);
  assert.equal(q.get("pn"), "MarginPulse Technologies");
  assert.ok(!url.includes("+"), "spaces must be %20, UPI apps do not decode +");
  assert.throws(() => buildUpiIntent({ vpa: "bad", payeeName: "x", amountInr: 5, reference: "r", note: "n" }));
  assert.throws(() => buildUpiIntent({ vpa: "a@b", payeeName: "x", amountInr: 0, reference: "r", note: "n" }));
  assert.ok(isValidVpa("a.b-c_d@okaxis")); assert.ok(!isValidVpa("a b@x")); assert.ok(!isValidVpa("@x"));
});

test("UTR must be exactly 12 digits; references are unique and unambiguous", () => {
  assert.ok(isValidUtr("412345678901")); assert.ok(isValidUtr(" 412345678901 "));
  for (const bad of ["41234567890", "4123456789012", "41234567890a", "", null, 412345678901]) assert.ok(!isValidUtr(bad as any), String(bad));
  const refs = new Set(Array.from({ length: 2000 }, () => newReference()));
  assert.equal(refs.size, 2000);
  for (const r of refs) assert.match(r, /^MP[A-HJ-NP-Z2-9]{10}$/);
});

test("gateway webhook signature: accepts t.rawBody HMAC; rejects tamper, wrong secret, stale, malformed, missing", async () => {
  const body = JSON.stringify({ event_id: "e-1", event: "order.paid" });
  const now = Date.now(), t = Math.floor(now / 1000);
  const sign = async (secret: string, ts: number, b = body) => `t=${ts},v1=${await hmacSha256Hex(secret, `${ts}.${b}`)}`;
  assert.deepEqual(await verifyUpiGatewaySignature("w", body, await sign("w", t), now), { ok: true, timestamp: t });
  assert.deepEqual(await verifyUpiGatewaySignature("w", body + " ", await sign("w", t), now), { ok: false, reason: "mismatch" });
  assert.deepEqual(await verifyUpiGatewaySignature("w", body, await sign("other", t), now), { ok: false, reason: "mismatch" });
  assert.deepEqual(await verifyUpiGatewaySignature("w", body, await sign("w", t - 301), now), { ok: false, reason: "stale" });
  assert.deepEqual(await verifyUpiGatewaySignature("w", body, await sign("w", t + 301), now), { ok: false, reason: "stale" });
  assert.deepEqual(await verifyUpiGatewaySignature("w", body, "v1=abc", now), { ok: false, reason: "malformed" });
  assert.deepEqual(await verifyUpiGatewaySignature("w", body, null, now), { ok: false, reason: "missing" });
  assert.deepEqual(await verifyUpiGatewaySignature(undefined, body, await sign("w", t), now), { ok: false, reason: "no_secret" });
});

const order = (o: object = {}) => ({ success: true, data: { order_id: "ORD1", client_order_id: "MPREF", amount: "499.00", status: "pending", environment: "live", test: false, payment_url: "https://pay.example.com/pay/ORD1", upi_intent: "upi://pay?pa=m@u", expires_at: "2026-11-12T12:15:00+05:30", ...o } });
const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test("gateway client: parses an order; retries once on 5xx/network; never retries a 4xx; refuses http in production", async () => {
  const env: any = { ...GW, ENVIRONMENT: "test" };
  const g = await createGatewayOrder(env, { amountInr: 499, clientOrderId: "MPREF" }, (async () => res(200, order())) as any);
  assert.deepEqual([g.orderId, g.amountInr, g.status, g.live, g.paymentUrl], ["ORD1", 499, "pending", true, "https://pay.example.com/pay/ORD1"]);
  assert.equal((await getGatewayOrder(env, "ORD1", (async () => res(200, order({ environment: "sandbox", test: true }))) as any)).live, false);

  let calls = 0;
  const flaky = (async () => (++calls === 1 ? res(503, {}) : res(200, order()))) as any;
  assert.equal((await getGatewayOrder(env, "ORD1", flaky)).orderId, "ORD1"); assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(getGatewayOrder(env, "ORD1", (async () => { calls++; return res(401, {}); }) as any), (e: any) => e instanceof GatewayError && e.retryable === false);
  assert.equal(calls, 1, "a 4xx is our bug/credentials, not worth retrying");

  calls = 0;
  await assert.rejects(getGatewayOrder(env, "ORD1", (async () => { calls++; throw new Error("socket hang up"); }) as any), (e: any) => e instanceof GatewayError && e.retryable === true);
  assert.equal(calls, 2, "exactly one retry");

  await assert.rejects(getGatewayOrder({ ...env, ENVIRONMENT: "production", UPI_GATEWAY_BASE_URL: "http://pay.example.com" }, "O", (async () => res(200, order())) as any), /https/);
  await assert.rejects(getGatewayOrder(env, "O", (async () => res(200, { success: false })) as any), /unexpected/);
});
