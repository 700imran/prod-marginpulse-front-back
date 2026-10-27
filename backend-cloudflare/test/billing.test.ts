import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createOrderHandler, verifyPaymentHandler, PLANS } from "../src/routes/billing.ts";
import { hmacSha256Hex } from "../src/lib_razorpay_sig.ts";

const ENV = { RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "secret123" } as any;
const TENANT = { tenantId: "11111111-2222-3333-4444-555555555555", ownerEmail: "a@b.in", planTier: "FREE" };

function appWith(sqlLog: string[], upgraded = 0) {
  const sql: any = (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join("?");
    sqlLog.push(q);
    if (/count\(\*\)/.test(q)) return Promise.resolve([{ n: String(upgraded) }]);
    return Promise.resolve([]);
  };
  const app = new Hono<any>();
  app.use("*", async (c, next) => { c.set("tenant", TENANT); c.set("sql", sql); await next(); });
  app.post("/create-order", createOrderHandler);
  app.post("/verify-payment", verifyPaymentHandler);
  return app;
}
const post = (app: Hono<any>, path: string, body: unknown) => app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, ENV);

function mockRazorpay(handler: (url: string, init?: RequestInit) => unknown) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => { const r = handler(String(url), init) as any; return new Response(JSON.stringify(r.body), { status: r.status ?? 200 }); }) as any;
  return () => { globalThis.fetch = real; };
}

test("create-order: client-supplied amount is ignored; price comes from the server plan table", async () => {
  let sent: any;
  const restore = mockRazorpay((_u, init) => { sent = JSON.parse(String(init!.body)); return { body: { id: "order_1", amount: sent.amount, currency: "INR", receipt: sent.receipt, status: "created" } }; });
  try {
    const res = await post(appWith([]), "/create-order", { plan: "pro", amount: 1 });
    assert.equal(res.status, 200);
    assert.equal(sent.amount, PLANS.pro.priceInr * 100);
    assert.ok(sent.receipt.length <= 40, "Razorpay rejects receipts over 40 chars");
    assert.equal(sent.notes.tenantId, TENANT.tenantId);
    assert.equal((await post(appWith([]), "/create-order", { amount: 1 })).status, 400); // no plan → refused
    assert.equal((await post(appWith([]), "/create-order", { plan: "__proto__" })).status, 400);
    assert.equal((await post(appWith([]), "/create-order", { plan: "free" })).status, 400);
  } finally { restore(); }
});

async function signed(orderId: string, paymentId: string) { return { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: await hmacSha256Hex(ENV.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`) }; }
const order = (o: object) => ({ id: "order_1", status: "paid", amount: PLANS.pro.priceInr * 100, amount_paid: PLANS.pro.priceInr * 100, currency: "INR", notes: { tenantId: TENANT.tenantId, plan: "pro" }, ...o });

test("verify-payment: bad signature rejected, no upgrade", async () => {
  const log: string[] = [];
  const res = await post(appWith(log), "/verify-payment", { razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: "00" });
  assert.equal(res.status, 400);
  assert.ok(!log.some((q) => /update tenants/.test(q)));
});

test("verify-payment: another tenant's order is refused (cannot reuse someone else's payment)", async () => {
  const log: string[] = [];
  const restore = mockRazorpay(() => ({ body: order({ notes: { tenantId: "99999999-0000-0000-0000-000000000000", plan: "pro" } }) }));
  try {
    const res = await post(appWith(log), "/verify-payment", await signed("order_1", "pay_1"));
    assert.equal(res.status, 403);
    assert.ok(!log.some((q) => /update tenants/.test(q)));
  } finally { restore(); }
});

test("verify-payment: unpaid order or wrong amount is refused", async () => {
  for (const o of [order({ status: "created" }), order({ amount: 100, amount_paid: 100 }), order({ amount_paid: 0 })]) {
    const log: string[] = [];
    const restore = mockRazorpay(() => ({ body: o }));
    try {
      const res = await post(appWith(log), "/verify-payment", await signed("order_1", "pay_1"));
      assert.equal(res.status, 402);
      assert.ok(!log.some((q) => /update tenants/.test(q)));
    } finally { restore(); }
  }
});

test("verify-payment: valid paid order upgrades the plan once; replays do not re-apply", async () => {
  const restore = mockRazorpay(() => ({ body: order({}) }));
  try {
    const log1: string[] = [];
    const r1 = await post(appWith(log1, 0), "/verify-payment", await signed("order_1", "pay_1"));
    assert.equal(r1.status, 200);
    assert.equal(((await r1.json()) as any).planTier, "GROWTH");
    assert.ok(log1.some((q) => /update tenants/.test(q)));
    assert.ok(log1.some((q) => /insert into audit_log/.test(q)));

    const log2: string[] = [];
    const r2 = await post(appWith(log2, 1), "/verify-payment", await signed("order_1", "pay_1"));
    assert.equal(r2.status, 200);
    assert.ok(!log2.some((q) => /update tenants/.test(q)), "replay must not re-apply");
  } finally { restore(); }
});
