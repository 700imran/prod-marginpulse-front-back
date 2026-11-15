// UPI fallback end to end against the real app + real Postgres: manual (UTR + admin approval) and gateway (create, signed
// webhook, poll) flows, plus the money-safety properties: price set by the server, one UTR = one payment, no downgrade,
// idempotent on duplicate/racing confirmations, sandbox events never upgrade a production plan.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { app } from "../src/index.ts";
import { DB_URL, startHarness, type Harness } from "./helpers/harness.ts";
import { hmacSha256Hex } from "../src/lib_razorpay_sig.ts";

const skip = DB_URL ? false : "TEST_DATABASE_URL not set";
let h: Harness; let gw: http.Server; let gwUrl = "";
const keepAlive = setInterval(() => {}, 1000);
const gwState = { mode: "ok" as "ok" | "down" | "flaky", created: [] as any[], paid: new Set<string>(), calls: 0, flakyLeft: 0 };
const VPA = "mp@okhdfcbank", WH = "whsec_test";
const rnd = () => String(Math.floor(Math.random() * 9e11) + 1e11); // UTRs are globally unique, so every run needs fresh ones
const U1 = rnd(), U2 = rnd(), U3 = rnd(), U4 = rnd();

before(async () => {
  if (skip) return;
  h = await startHarness();
  gw = http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
      gwState.calls++;
      const json = (s: number, o: unknown) => { res.statusCode = s; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
      if (req.headers["x-api-key"] !== "gk" || req.headers["x-api-secret"] !== "gs") return json(401, { success: false });
      if (gwState.mode === "down") return json(503, {});
      if (gwState.mode === "flaky" && gwState.flakyLeft-- > 0) return json(503, {});
      if (req.method === "POST" && req.url === "/api/v1/orders") {
        const b = JSON.parse(body); const id = `ORD${crypto.randomUUID().slice(0, 12)}`;
        const o = { order_id: id, client_order_id: b.client_order_id, amount: Number(b.amount).toFixed(2), status: "pending", environment: "live", test: false, payment_url: `${gwUrl}/pay/${id}`, upi_intent: `upi://pay?pa=gw@upi&am=${b.amount}&tr=${id}`, expires_at: new Date(Date.now() + 1800_000).toISOString() };
        gwState.created.push(o); return json(200, { success: true, data: o });
      }
      const m = /^\/api\/v1\/orders\/(.+)$/.exec(req.url ?? "");
      const o = m && gwState.created.find((x) => x.order_id === m[1]);
      if (req.method === "GET" && o) return json(200, { success: true, data: { ...o, status: gwState.paid.has(o.order_id) ? "paid" : "pending" } });
      json(404, {});
    });
  });
  await new Promise<void>((r) => gw.listen(0, "127.0.0.1", r));
  gwUrl = `http://127.0.0.1:${(gw.address() as any).port}`;
});
after(async () => { clearInterval(keepAlive); if (gw) gw.close(); if (h) await h.close(); });

const useManual = () => Object.assign(h.env, { UPI_FALLBACK_ENABLED: "true", UPI_VPA: VPA, UPI_PAYEE_NAME: "MarginPulse", UPI_GATEWAY_BASE_URL: "", UPI_GATEWAY_API_KEY: "", UPI_GATEWAY_API_SECRET: "", UPI_GATEWAY_WEBHOOK_SECRET: "" });
const useGateway = () => Object.assign(h.env, { UPI_FALLBACK_ENABLED: "true", UPI_VPA: "", UPI_GATEWAY_BASE_URL: gwUrl, UPI_GATEWAY_API_KEY: "gk", UPI_GATEWAY_API_SECRET: "gs", UPI_GATEWAY_WEBHOOK_SECRET: WH });
const tier = async (id: string) => (await h.admin<any[]>`select plan_tier from tenants where tenant_id = ${id}`)[0]?.plan_tier;
const mkTenant = async (label: string, planTier = "FREE") => { const t = await h.newTenant(label); await h.admin`insert into tenants (tenant_id, business_name, owner_email, plan_tier) values (${t.tenantId}, ${label}, ${t.email}, ${planTier}) on conflict (tenant_id) do update set plan_tier = ${planTier}`; return t; };
const mkAdmin = async () => { const a = await h.newTenant("upiadmin"); await h.admin`insert into tenants (tenant_id, business_name, owner_email, is_platform_admin) values (${a.tenantId}, 'Admin', ${a.email}, true) on conflict (tenant_id) do update set is_platform_admin = true`; return a; };
const signed = async (payload: object, { ts = Math.floor(Date.now() / 1000), secret = WH }: { ts?: number; secret?: string } = {}) => {
  const raw = JSON.stringify(payload);
  return app.fetch(new Request("https://api.test/webhook/upi-gateway", { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": `t=${ts},v1=${await hmacSha256Hex(secret, `${ts}.${raw}`)}`, "CF-Connecting-IP": "198.51.100.5" }, body: raw }), h.env, { waitUntil() {}, passThroughOnException() {} } as any);
};
const paid = (p: any, extra: object = {}) => ({ event_id: `evt_${crypto.randomUUID()}`, event_sequence: 2, event: "order.paid", data: { order_id: p.gatewayOrderId, client_order_id: p.reference, amount: `${p.amountInr}.00`, status: "paid", environment: "live", ...extra } });

test("disabled by default: config says so and creating an order is refused", { skip }, async () => {
  const t = await mkTenant("off");
  delete h.env.UPI_FALLBACK_ENABLED;
  assert.equal((await h.call(t.token, "GET", "/api/v1/billing/upi/config")).json.enabled, false);
  assert.equal((await h.call(t.token, "POST", "/api/v1/billing/upi/orders", { plan: "pro" })).status, 404);
});

test("manual: server sets the price; UTR → admin approval → plan upgraded once; audit trail written", { skip }, async () => {
  useManual();
  const t = await mkTenant("man"), admin = await mkAdmin();
  const cfg = await h.call(t.token, "GET", "/api/v1/billing/upi/config");
  assert.deepEqual([cfg.json.enabled, cfg.json.mode], [true, "manual"]);
  assert.equal((await h.call(t.token, "POST", "/api/v1/billing/upi/orders", { plan: "free" })).status, 400);
  const o = await h.call(t.token, "POST", "/api/v1/billing/upi/orders", { plan: "starter", amount: 1, amountInr: 1 }); // the client "tries" to set the price
  assert.equal(o.status, 201, o.text);
  assert.equal(o.json.amountInr, 499);
  const q = new URL(o.json.upiIntent.replace("upi://", "https://x/")).searchParams;
  assert.deepEqual([q.get("pa"), q.get("am"), q.get("tr")], [VPA, "499.00", o.json.reference]);
  const id = o.json.paymentId;

  assert.equal((await h.call(t.token, "POST", `/api/v1/billing/upi/orders/${id}/utr`, { utr: "12345" })).status, 400);
  const other = await mkTenant("man-other");
  assert.equal((await h.call(other.token, "POST", `/api/v1/billing/upi/orders/${id}/utr`, { utr: U1 })).status, 404, "another tenant cannot touch it");
  assert.equal((await h.call(other.token, "GET", `/api/v1/billing/upi/orders/${id}`)).status, 404);
  assert.equal((await h.call(t.token, "POST", `/api/v1/billing/upi/orders/${id}/utr`, { utr: U1 })).json.status, "SUBMITTED");
  assert.equal((await h.call(t.token, "POST", `/api/v1/billing/upi/orders/${id}/utr`, { utr: U2 })).status, 409, "no second UTR once submitted");

  assert.equal(await tier(t.tenantId), "FREE", "a submitted UTR alone must not upgrade anything");
  assert.equal((await h.call(t.token, "POST", `/api/v1/admin/upi-payments/${id}/approve`)).status, 403);
  const list = await h.call(admin.token, "GET", "/api/v1/admin/upi-payments?status=SUBMITTED");
  assert.ok(list.json.payments.some((p: any) => p.paymentId === id && p.utr === U1));
  const ap = await h.call(admin.token, "POST", `/api/v1/admin/upi-payments/${id}/approve`);
  assert.equal(ap.status, 200, ap.text); assert.equal(ap.json.planTier, "STARTER");
  assert.equal(await tier(t.tenantId), "STARTER");
  assert.equal((await h.call(admin.token, "POST", `/api/v1/admin/upi-payments/${id}/approve`)).status, 409, "double-click is harmless");
  const audit = await h.admin<any[]>`select reason, new_value from audit_log where tenant_id = ${t.tenantId} and action = 'PLAN_UPGRADED'`;
  assert.equal(audit.length, 1); assert.match(audit[0].reason, new RegExp(`utr ${U1}`));
  assert.equal((await h.call(t.token, "GET", `/api/v1/billing/upi/orders/${id}`)).json.status, "PAID");
});

test("manual: one UTR funds one payment; reject works; an approval never downgrades; open-order cap", { skip }, async () => {
  useManual();
  const t = await mkTenant("man2", "GROWTH"), admin = await mkAdmin();
  const mk = async (plan: string) => (await h.call(t.token, "POST", "/api/v1/billing/upi/orders", { plan })).json;
  const a = await mk("starter"), b = await mk("pro");
  assert.equal((await h.call(t.token, "POST", `/api/v1/billing/upi/orders/${a.paymentId}/utr`, { utr: U3 })).status, 200);
  assert.equal((await h.call(t.token, "POST", `/api/v1/billing/upi/orders/${b.paymentId}/utr`, { utr: U3 })).status, 409, "the same UTR cannot fund a second payment");
  assert.equal((await h.call(admin.token, "POST", `/api/v1/admin/upi-payments/${a.paymentId}/approve`)).json.planTier, "GROWTH", "starter approval must not downgrade GROWTH");
  assert.equal(await tier(t.tenantId), "GROWTH");
  assert.equal((await h.call(t.token, "POST", `/api/v1/billing/upi/orders/${b.paymentId}/utr`, { utr: U4 })).status, 200);
  assert.equal((await h.call(admin.token, "POST", `/api/v1/admin/upi-payments/${b.paymentId}/reject`)).json.status, "rejected");
  assert.equal((await h.call(admin.token, "POST", `/api/v1/admin/upi-payments/${b.paymentId}/approve`)).status, 409, "a rejected payment cannot be approved");
  const t2 = await mkTenant("cap");
  for (let i = 0; i < 3; i++) assert.equal((await h.call(t2.token, "POST", "/api/v1/billing/upi/orders", { plan: "pro" })).status, 201);
  assert.equal((await h.call(t2.token, "POST", "/api/v1/billing/upi/orders", { plan: "pro" })).status, 429);
});

test("manual: approving a payment that never got a UTR is refused", { skip }, async () => {
  useManual();
  const t = await mkTenant("noutr"), admin = await mkAdmin();
  const o = (await h.call(t.token, "POST", "/api/v1/billing/upi/orders", { plan: "pro" })).json;
  assert.equal((await h.call(admin.token, "POST", `/api/v1/admin/upi-payments/${o.paymentId}/approve`)).status, 409);
  assert.equal(await tier(t.tenantId), "FREE");
});

test("gateway: order created at the gateway; signed webhook upgrades once; duplicates, bad signatures and stale timestamps do nothing", { skip }, async () => {
  useGateway(); gwState.mode = "ok";
  const t = await mkTenant("gw");
  const o = await h.call(t.token, "POST", "/api/v1/billing/upi/orders", { plan: "pro" });
  assert.equal(o.status, 201, o.text);
  assert.ok(o.json.paymentUrl.startsWith(gwUrl) && o.json.upiIntent.startsWith("upi://"));
  const row = (await h.admin<any[]>`select payment_id as "paymentId", reference, gateway_order_id as "gatewayOrderId", amount_inr as "amountInr" from upi_payments where payment_id = ${o.json.paymentId}`)[0];
  assert.equal(gwState.created.at(-1).client_order_id, row.reference, "our reference is the gateway's client_order_id");

  assert.equal((await signed(paid(row), { secret: "wrong" })).status, 401);
  assert.equal((await signed(paid(row), { ts: Math.floor(Date.now() / 1000) - 600 })).status, 401);
  const unsigned = await app.fetch(new Request("https://api.test/webhook/upi-gateway", { method: "POST", body: JSON.stringify(paid(row)) }), h.env, { waitUntil() {}, passThroughOnException() {} } as any);
  assert.equal(unsigned.status, 401);
  assert.equal(await tier(t.tenantId), "FREE");

  const ev = paid(row);
  const r1 = await signed(ev); assert.equal(r1.status, 200); assert.equal(((await r1.json()) as any).status, "ok");
  assert.equal(await tier(t.tenantId), "GROWTH");
  const r2 = await signed(ev); assert.equal(((await r2.json()) as any).status, "duplicate");
  const r3 = await signed(paid(row)); assert.equal(((await r3.json()) as any).status, "already_paid", "a different event for an already paid order is harmless");
  assert.equal((await h.admin<any[]>`select count(*)::int as n from audit_log where tenant_id = ${t.tenantId} and action = 'PLAN_UPGRADED'`)[0].n, 1);
});

test("gateway: wrong amount / wrong order id / unknown reference never upgrade; sandbox events are ignored in production", { skip }, async () => {
  useGateway();
  const t = await mkTenant("gw-bad");
  const o = (await h.call(t.token, "POST", "/api/v1/billing/upi/orders", { plan: "enterprise" })).json;
  const row = (await h.admin<any[]>`select reference, gateway_order_id as "gatewayOrderId", amount_inr as "amountInr" from upi_payments where payment_id = ${o.paymentId}`)[0];
  assert.equal(((await (await signed(paid(row, { amount: "1.00" }))).json()) as any).status, "mismatch_ignored");
  assert.equal(((await (await signed(paid(row, { order_id: "ORD-other" }))).json()) as any).status, "mismatch_ignored");
  assert.equal(((await (await signed(paid({ ...row, reference: "MPNOSUCHREF" }))).json()) as any).status, "unknown_order");
  assert.equal(await tier(t.tenantId), "FREE");
  const prev = h.env.ENVIRONMENT; h.env.ENVIRONMENT = "production";
  try { assert.equal(((await (await signed(paid(row, { environment: "sandbox", test: true }))).json()) as any).status, "ignored_test_event"); } finally { h.env.ENVIRONMENT = prev; }
  assert.equal(await tier(t.tenantId), "FREE", "a sandbox 'paid' must never buy a production plan");
});

test("gateway: polling confirms a payment even if the webhook never arrives; a dead gateway degrades gracefully", { skip }, async () => {
  useGateway(); gwState.mode = "ok";
  const t = await mkTenant("gw-poll");
  const o = (await h.call(t.token, "POST", "/api/v1/billing/upi/orders", { plan: "starter" })).json;
  const before = await h.call(t.token, "GET", `/api/v1/billing/upi/orders/${o.paymentId}`);
  assert.deepEqual([before.json.status, before.json.gatewayCheck], ["PENDING", "ok"]);
  gwState.mode = "down";
  const down = await h.call(t.token, "GET", `/api/v1/billing/upi/orders/${o.paymentId}`);
  assert.deepEqual([down.status, down.json.status, down.json.gatewayCheck], [200, "PENDING", "unavailable"], "poll failure must not break the screen");
  gwState.mode = "ok"; gwState.paid.add(gwState.created.at(-1).order_id);
  const after = await h.call(t.token, "GET", `/api/v1/billing/upi/orders/${o.paymentId}`);
  assert.equal(after.json.status, "PAID"); assert.equal(await tier(t.tenantId), "STARTER");
  const again = await h.call(t.token, "GET", `/api/v1/billing/upi/orders/${o.paymentId}`);
  assert.equal(again.json.status, "PAID");
  assert.equal((await h.admin<any[]>`select count(*)::int as n from audit_log where tenant_id = ${t.tenantId} and action = 'PLAN_UPGRADED'`)[0].n, 1);
});

test("gateway: a transient 503 is retried once and succeeds; a dead gateway gives a clear 502 and leaves nothing payable", { skip }, async () => {
  useGateway();
  const t = await mkTenant("gw-retry");
  gwState.mode = "flaky"; gwState.flakyLeft = 1; gwState.calls = 0;
  const ok = await h.call(t.token, "POST", "/api/v1/billing/upi/orders", { plan: "starter" });
  assert.equal(ok.status, 201, ok.text); assert.equal(gwState.calls, 2);
  gwState.mode = "down";
  const bad = await h.call(t.token, "POST", "/api/v1/billing/upi/orders", { plan: "pro" });
  assert.equal(bad.status, 502); assert.match(bad.json.error, /not been charged/);
  assert.equal((await h.admin<any[]>`select count(*)::int as n from upi_payments where tenant_id = ${t.tenantId} and status = 'EXPIRED'`)[0].n, 1);
  gwState.mode = "ok";
});

test("the Razorpay flow is untouched: create-order still reports 'not configured' without keys", { skip }, async () => {
  const t = await mkTenant("rzp");
  const r = await h.call(t.token, "POST", "/api/v1/billing/create-order", { plan: "pro" });
  assert.equal(r.status, 500); assert.match(r.json.error, /Razorpay is not configured/);
});
