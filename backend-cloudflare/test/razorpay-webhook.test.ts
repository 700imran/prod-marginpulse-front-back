// The browser's verify-payment call is NOT the only way a paid plan must activate: customers close the tab, lose signal, or are
// sent through a UPI app on their phone and never return. Razorpay's webhook (order.paid / payment.captured) must activate the
// plan on its own, exactly once, even when it races the browser's call. Real Postgres + a fake Razorpay API. Needs TEST_DATABASE_URL.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { DB_URL, startHarness, type Harness } from "./helpers/harness.ts";
import { hmacSha256Hex } from "../src/lib_razorpay_sig.ts";
import { PLANS } from "../src/billing/plans.ts";

const skip = DB_URL ? false : "TEST_DATABASE_URL not set";
const KEY_SECRET = "rzp_secret_for_tests", WH_SECRET = "wh_secret_for_tests";
let h: Harness;
const keepAlive = setInterval(() => {}, 1000);
const realFetch = globalThis.fetch;
type FakeOrder = { id: string; status: string; amount: number; amount_paid: number; currency: string; notes: Record<string, string> };
const orders = new Map<string, FakeOrder>();
let razorpayDown = false;
let orderFetches = 0;

before(async () => {
  if (skip) return;
  h = await startHarness();
  Object.assign(h.env as any, { RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: KEY_SECRET, RAZORPAY_WEBHOOK_SECRET: WH_SECRET });
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (!u.startsWith("https://api.razorpay.com/v1/orders/")) return realFetch(url, init); // the harness's own JWKS/Redis stubs
    orderFetches++;
    if (razorpayDown) return new Response("{}", { status: 503 });
    const o = orders.get(decodeURIComponent(u.split("/").pop()!));
    return o ? new Response(JSON.stringify(o), { status: 200 }) : new Response("{}", { status: 400 });
  }) as any;
});
after(async () => { clearInterval(keepAlive); globalThis.fetch = realFetch; if (h) await h.close(); });

let seq = 0;
async function paidOrder(tenantId: string, plan: "starter" | "pro" | "enterprise", over: Partial<FakeOrder> = {}) {
  const id = `order_t${++seq}_${Date.now()}`, amount = PLANS[plan].priceInr * 100;
  const o: FakeOrder = { id, status: "paid", amount, amount_paid: amount, currency: "INR", notes: { tenantId, plan }, ...over };
  orders.set(id, o);
  return { order: o, paymentId: `pay_t${seq}_${Date.now()}` };
}
const eventBody = (event: string, orderId: string, paymentId: string) =>
  event === "order.paid"
    ? { event, payload: { payment: { entity: { id: paymentId, order_id: orderId, status: "captured" } }, order: { entity: { id: orderId, status: "paid" } } } }
    : { event, payload: { payment: { entity: { id: paymentId, order_id: orderId, status: "captured" } } } };
async function webhook(body: object, eventId = `evt_${Math.random().toString(36).slice(2, 12)}`, signatureOverride?: string) {
  const raw = JSON.stringify(body); // h.call serialises with JSON.stringify too, so the signature below covers the exact bytes sent
  const sig = signatureOverride ?? (await hmacSha256Hex(WH_SECRET, raw));
  const t = await h.newTenant("wh-caller");
  return h.call(t.token, "POST", "/api/razorpay/webhook", body, { "X-Razorpay-Signature": sig, "X-Razorpay-Event-Id": eventId });
}
const verifyBody = async (orderId: string, paymentId: string) => ({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: await hmacSha256Hex(KEY_SECRET, `${orderId}|${paymentId}`) });
const tier = async (tenantId: string) => (await h.admin<{ t: string }[]>`select plan_tier as t from tenants where tenant_id = ${tenantId}`)[0]!.t;
const upgrades = (tenantId: string) => h.admin<{ reason: string }[]>`select reason from audit_log where tenant_id = ${tenantId} and action = 'PLAN_UPGRADED'`;

test("webhook alone activates the plan (customer never came back to the page), and a redelivery changes nothing", { skip }, async () => {
  const t = await h.newTenant("wh-solo");
  const { order, paymentId } = await paidOrder(t.tenantId, "pro");
  const evtId = "evt_solo_1";
  const r1 = await webhook(eventBody("order.paid", order.id, paymentId), evtId);
  assert.equal(r1.status, 200, r1.text);
  assert.equal(await tier(t.tenantId), "GROWTH");
  const rows = await upgrades(t.tenantId);
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.reason, new RegExp(paymentId));
  const r2 = await webhook(eventBody("order.paid", order.id, paymentId), evtId); // Razorpay redelivers the same event
  assert.equal(r2.status, 200);
  assert.equal((await upgrades(t.tenantId)).length, 1, "no second audit entry / no second upgrade");
});

test("payment.captured (order id only on the payment entity) works the same way", { skip }, async () => {
  const t = await h.newTenant("wh-captured");
  const { order, paymentId } = await paidOrder(t.tenantId, "starter");
  assert.equal((await webhook(eventBody("payment.captured", order.id, paymentId))).status, 200);
  assert.equal(await tier(t.tenantId), "STARTER");
});

test("browser verify-payment and the webhook racing each other apply the payment exactly once", { skip }, async () => {
  for (let round = 0; round < 8; round++) {
    const t = await h.newTenant("wh-race");
    const { order, paymentId } = await paidOrder(t.tenantId, "pro");
    const body = eventBody("order.paid", order.id, paymentId);
    const [v, w] = await Promise.all([h.call(t.token, "POST", "/api/v1/billing/verify-payment", await verifyBody(order.id, paymentId)), webhook(body)]);
    assert.equal(v.status, 200, `round ${round}: ${v.text}`); assert.equal(w.status, 200, `round ${round}: ${w.text}`);
    assert.equal(v.json.planTier, "GROWTH");
    assert.equal(await tier(t.tenantId), "GROWTH");
    assert.equal((await upgrades(t.tenantId)).length, 1, `round ${round}: one payment must be recorded once`);
  }
});

test("a forged / unsigned webhook is refused and changes nothing", { skip }, async () => {
  const t = await h.newTenant("wh-forged");
  const { order, paymentId } = await paidOrder(t.tenantId, "enterprise");
  assert.equal((await webhook(eventBody("order.paid", order.id, paymentId), "evt_f1", "00".repeat(32))).status, 400);
  assert.equal(await tier(t.tenantId), "FREE");
});

test("the webhook trusts Razorpay's order, not the webhook body: unpaid, short-paid and foreign orders do nothing", { skip }, async () => {
  const t = await h.newTenant("wh-bad");
  const cases: [string, Partial<FakeOrder>][] = [
    ["unpaid order", { status: "attempted", amount_paid: 0 }],
    ["wrong amount", { amount: 100, amount_paid: 100 }],
    ["part-paid", { amount_paid: 1000 }],
    ["not our order (no notes)", { notes: {} }],
  ];
  for (const [label, over] of cases) {
    const { order, paymentId } = await paidOrder(t.tenantId, "pro", over);
    const r = await webhook(eventBody("order.paid", order.id, paymentId));
    assert.equal(r.status, 200, `${label}: acknowledged so Razorpay stops retrying`);
    assert.equal(await tier(t.tenantId), "FREE", `${label}: no upgrade`);
  }
  assert.equal((await upgrades(t.tenantId)).length, 0);
});

test("Razorpay unreachable → 5xx so Razorpay redelivers, and the redelivery (same event id) IS processed", { skip }, async () => {
  const t = await h.newTenant("wh-retry");
  const { order, paymentId } = await paidOrder(t.tenantId, "pro");
  const evtId = "evt_retry_1";
  razorpayDown = true;
  try { assert.equal((await webhook(eventBody("order.paid", order.id, paymentId), evtId)).status, 500); } finally { razorpayDown = false; }
  assert.equal(await tier(t.tenantId), "FREE");
  assert.equal((await webhook(eventBody("order.paid", order.id, paymentId), evtId)).status, 200);
  assert.equal(await tier(t.tenantId), "GROWTH", "the retry must not be swallowed as a duplicate");
});

test("a payment for a lower plan never downgrades a higher one, but is still recorded", { skip }, async () => {
  const t = await h.newTenant("wh-nodown");
  await h.admin`update tenants set plan_tier = 'ENTERPRISE' where tenant_id = ${t.tenantId}`;
  const { order, paymentId } = await paidOrder(t.tenantId, "starter");
  assert.equal((await webhook(eventBody("order.paid", order.id, paymentId))).status, 200);
  assert.equal(await tier(t.tenantId), "ENTERPRISE");
  const rows = await upgrades(t.tenantId);
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.reason, /no downgrade applied/);
});

test("events that are not payments (refund, failure, unknown) are acknowledged without touching Razorpay or the plan", { skip }, async () => {
  const before = orderFetches;
  for (const ev of ["payment.failed", "refund.processed", "something.new"]) assert.equal((await webhook({ event: ev, payload: {} })).status, 200);
  assert.equal(orderFetches, before);
});
