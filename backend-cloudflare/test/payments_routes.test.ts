// The money paths through the real route code. Only the database layer, auth,
// rate limiting and the network (Razorpay's API) are replaced.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createHmac } from "node:crypto";

const h = vi.hoisted(() => ({
  plan: "FREE", tenantId: "t-1",
  insertOrder: vi.fn(), activate: vi.fn(), currentPlan: vi.fn(),
  setPriv: vi.fn(), reportError: vi.fn(),
  rzp: [] as { url: string; init: any }[], rzpReply: null as null | ((url: string, init?: any) => Response),
}));
vi.mock("../src/middleware/auth", () => ({
  requireAuth: async (c: any, next: any) => { c.set("tenant", { tenantId: h.tenantId, planTier: h.plan, ownerEmail: "o@x.in", planExpiresAt: null }); c.set("sql", {}); c.set("requestId", "req-1"); await next(); },
}));
vi.mock("../src/middleware/rateLimit", () => ({ rateLimit: () => async (_c: any, next: any) => next() }));
vi.mock("../src/repository/payments", () => ({ insertPaymentOrder: h.insertOrder, activatePaidOrder: h.activate, currentPlanOf: h.currentPlan, planRank: (p: string) => ["FREE", "STARTER", "GROWTH", "ENTERPRISE"].indexOf(p) }));
vi.mock("../src/security/tenantContext", () => ({ setPrivilegedContext: h.setPriv, setTenantContext: vi.fn() }));
vi.mock("../src/monitoring", () => ({ reportError: h.reportError }));
vi.mock("../src/billing/credits", () => ({ ensureMonthlyGrant: vi.fn(), getWalletSummary: vi.fn(), listLedger: vi.fn(), ensureWallet: vi.fn() }));
vi.mock("../src/billing/usage", () => ({ listUsageEvents: vi.fn() }));
vi.mock("../src/repository/tenants", () => ({ getTenantByWhatsAppPhone: vi.fn(), getTenantByIngestEmailAlias: vi.fn() }));
vi.mock("../src/repository/documents", () => ({ createDocument: vi.fn() }));
vi.mock("../src/storage", () => ({ uploadBytes: vi.fn() }));

import { billingRoutes } from "../src/routes/billing";
import { webhookRoutes } from "../src/routes/webhooks";

const SECRET = "key_secret", WHSEC = "wh_secret";
const ENV = (over: Record<string, string> = {}) => ({
  RAZORPAY_KEY_ID: "rzp_test_abc", RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_WEBHOOK_SECRET: WHSEC,
  PLAN_PRICES_INR: '{"STARTER":999,"GROWTH":2499}', ...over,
});
const ctx: any = { waitUntil() {}, passThroughOnException() {} };
const app = () => { const a = new Hono<any>(); a.use("*", async (c, n) => { c.set("sql", {}); await n(); }); a.route("/billing", billingRoutes); a.route("/webhook", webhookRoutes); return a; };
const post = (path: string, body: unknown, env = ENV(), headers: Record<string, string> = {}) =>
  app().request(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }, env, ctx);
const json = async (r: Response) => (await r.json()) as any;
const sign = (secret: string, msg: string) => createHmac("sha256", secret).update(msg).digest("hex");

beforeEach(() => {
  h.plan = "FREE"; h.tenantId = "t-1"; h.rzp.length = 0;
  h.insertOrder.mockReset().mockResolvedValue(undefined);
  h.activate.mockReset().mockResolvedValue({ status: "ACTIVATED", tenantId: "t-1", plan: "STARTER", expiresAt: "2026-11-21T00:00:00Z", creditsGranted: 140 });
  h.currentPlan.mockReset().mockResolvedValue("FREE");
  h.setPriv.mockReset(); h.reportError.mockReset();
  // Like the real API, an order comes back with the amount that was requested.
  h.rzpReply = (url, init) => (url.endsWith("/orders") ? Response.json({ id: "order_NEW123", amount: JSON.parse(init.body).amount, currency: "INR" })
    : Response.json({ id: "pay_OK1234", order_id: "order_NEW123", amount: 99900, currency: "INR", status: "captured" }));
  globalThis.fetch = (async (url: string, init: any) => { h.rzp.push({ url, init }); return h.rzpReply!(url, init); }) as any;
  vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("GET /billing/plans", () => {
  it("reports plan, catalogue, features, and whether locking/payments are on", async () => {
    h.plan = "STARTER";
    const r = await app().request("/billing/plans", {}, ENV({ ENFORCE_PLAN_GATING: "true" }), ctx);
    const b = await json(r);
    expect(b).toMatchObject({ currentPlan: "STARTER", currentPlanLabel: "Starter", gatingEnforced: true, paymentsEnabled: true });
    expect(b.features.team).toMatchObject({ minPlan: "GROWTH", minPlanLabel: "Pro" });
    expect(b.plans.find((p: any) => p.id === "STARTER")).toMatchObject({ priceInr: 999, purchasable: true });
    expect(b.plans.find((p: any) => p.id === "ENTERPRISE")).toMatchObject({ priceInr: null, purchasable: false });
    expect(JSON.stringify(b)).not.toContain(SECRET);
  });
  it("defaults: not enforcing, payments off, no invented prices", async () => {
    const b = await json(await app().request("/billing/plans", {}, {}, ctx));
    expect(b).toMatchObject({ gatingEnforced: false, paymentsEnabled: false });
    expect(b.plans.every((p: any) => p.priceInr === null || p.id === "FREE")).toBe(true);
  });
});

describe("POST /billing/checkout", () => {
  it("creates an order for the SERVER's price — a client-supplied amount is ignored — and stores it", async () => {
    const r = await post("/billing/checkout", { plan: "STARTER", amount: 1, amountPaise: 1, price: 1 });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ keyId: "rzp_test_abc", orderId: "order_NEW123", amount: 99900, currency: "INR", plan: "STARTER", planLabel: "Starter", email: "o@x.in" });
    expect(JSON.parse(h.rzp[0]!.init.body)).toMatchObject({ amount: 99900, currency: "INR", notes: { tenant_id: "t-1", plan: "STARTER" } });
    expect(h.insertOrder).toHaveBeenCalledWith({}, { tenantId: "t-1", plan: "STARTER", months: 1, amountPaise: 99900, razorpayOrderId: "order_NEW123" });
  });
  it("never reveals the key secret", async () => {
    expect(JSON.stringify(await json(await post("/billing/checkout", { plan: "STARTER" })))).not.toContain(SECRET);
  });
  it.each([{}, { plan: "FREE" }, { plan: "ADMIN" }, { plan: 5 }, { plan: null }])("rejects invalid plan %j", async (b) => {
    expect((await post("/billing/checkout", b)).status).toBe(400);
    expect(h.rzp.length).toBe(0);
  });
  it("rejects non-JSON", async () => { expect((await post("/billing/checkout", "not json")).status).toBe(400); });
  it("501 when payments aren't configured, and when that plan has no price — with no call to Razorpay", async () => {
    expect((await post("/billing/checkout", { plan: "STARTER" }, ENV({ RAZORPAY_WEBHOOK_SECRET: "" }))).status).toBe(501);
    expect((await post("/billing/checkout", { plan: "ENTERPRISE" })).status).toBe(501);
    expect(h.rzp.length).toBe(0);
  });
  it("409 when buying a lower plan than the one still active; renewing the same plan is allowed", async () => {
    h.currentPlan.mockResolvedValue("GROWTH");
    expect((await post("/billing/checkout", { plan: "STARTER" })).status).toBe(409);
    expect((await post("/billing/checkout", { plan: "GROWTH" })).status).toBe(200);
  });
  it("502 and NO order row when Razorpay fails", async () => {
    h.rzpReply = () => Response.json({ error: { description: "boom" } }, { status: 500 });
    const r = await post("/billing/checkout", { plan: "STARTER" });
    expect(r.status).toBe(502);
    expect(h.insertOrder).not.toHaveBeenCalled();
    expect(JSON.stringify(await json(r))).not.toContain("boom");
  });
});

describe("POST /billing/verify (browser confirmation)", () => {
  const good = () => ({ razorpay_order_id: "order_NEW123", razorpay_payment_id: "pay_OK1234", razorpay_signature: sign(SECRET, "order_NEW123|pay_OK1234") });
  it("activates only after: valid signature → Razorpay says captured for this order → amount from Razorpay", async () => {
    const r = await post("/billing/verify", good());
    expect(await json(r)).toMatchObject({ status: "ACTIVE", plan: "STARTER", planLabel: "Starter" });
    expect(h.activate).toHaveBeenCalledWith({}, { razorpayOrderId: "order_NEW123", paymentId: "pay_OK1234", amountPaise: 99900, currency: "INR", expectTenantId: "t-1" });
  });
  it("a forged signature is refused before anything else happens", async () => {
    const r = await post("/billing/verify", { ...good(), razorpay_signature: sign("attacker", "order_NEW123|pay_OK1234") });
    expect(r.status).toBe(400);
    expect(h.rzp.length).toBe(0);
    expect(h.activate).not.toHaveBeenCalled();
  });
  it("a valid signature for a DIFFERENT order than Razorpay reports is refused", async () => {
    h.rzpReply = () => Response.json({ id: "pay_OK1234", order_id: "order_OTHER", amount: 99900, currency: "INR", status: "captured" });
    expect((await post("/billing/verify", good())).status).toBe(400);
    expect(h.activate).not.toHaveBeenCalled();
  });
  it("authorized-but-not-captured → 202 pending, nothing granted", async () => {
    h.rzpReply = () => Response.json({ id: "pay_OK1234", order_id: "order_NEW123", amount: 99900, currency: "INR", status: "authorized" });
    const r = await post("/billing/verify", good());
    expect(r.status).toBe(202);
    expect(h.activate).not.toHaveBeenCalled();
  });
  it("Razorpay unreachable → 202 pending (the webhook will finish it), nothing granted", async () => {
    h.rzpReply = () => new Response("down", { status: 503 });
    expect((await post("/billing/verify", good())).status).toBe(202);
    expect(h.activate).not.toHaveBeenCalled();
  });
  it("an already-processed order is reported as active, not an error", async () => {
    h.activate.mockResolvedValue({ status: "ALREADY_PAID" });
    expect(await json(await post("/billing/verify", good()))).toMatchObject({ status: "ACTIVE" });
  });
  it("amount mismatch → 409 and an alert; someone else's order → 404", async () => {
    h.activate.mockResolvedValue({ status: "AMOUNT_MISMATCH" });
    expect((await post("/billing/verify", good())).status).toBe(409);
    expect(h.reportError).toHaveBeenCalled();
    h.activate.mockResolvedValue({ status: "WRONG_TENANT" });
    expect((await post("/billing/verify", good())).status).toBe(404);
  });
  it.each([{}, { razorpay_order_id: "x" }, { razorpay_order_id: "order_1; drop", razorpay_payment_id: "pay_1", razorpay_signature: "s" }, { razorpay_order_id: "order_NEW123", razorpay_payment_id: "pay_OK1234", razorpay_signature: "x".repeat(500) }])("rejects malformed body %j", async (b) => {
    expect((await post("/billing/verify", b)).status).toBe(400);
    expect(h.rzp.length).toBe(0);
  });
  it("501 when payments are off", async () => { expect((await post("/billing/verify", good(), ENV({ RAZORPAY_KEY_SECRET: "" }))).status).toBe(501); });
});

describe("POST /webhook/razorpay", () => {
  const event = (over: any = {}) => JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_OK1234", order_id: "order_NEW123", amount: 99900, currency: "INR", status: "captured", ...over } } } });
  const send = (body: string, sig: string | null = sign(WHSEC, body), env = ENV()) => post("/webhook/razorpay", body, env, sig === null ? {} : { "X-Razorpay-Signature": sig });

  it("a correctly signed capture activates the order using the provider's amount", async () => {
    const r = await send(event());
    expect(await json(r)).toEqual({ ok: true, result: "ACTIVATED" });
    expect(h.activate).toHaveBeenCalledWith({}, { razorpayOrderId: "order_NEW123", paymentId: "pay_OK1234", amountPaise: 99900, currency: "INR" });
    expect(h.setPriv.mock.calls.map((c) => c[1])).toEqual([{ system: true }, { system: false }]); // privileged only for the duration
  });
  it("missing, wrong, or body-mismatched signature → 401 and nothing touches the database", async () => {
    for (const sig of [null, "", "deadbeef", sign("wrong", event())]) expect((await send(event(), sig)).status).toBe(401);
    expect((await send(event(), sign(WHSEC, event({ amount: 1 })))).status).toBe(401); // signed a different body
    expect(h.activate).not.toHaveBeenCalled();
    expect(h.setPriv).not.toHaveBeenCalled();
  });
  it("a Razorpay retry or a browser-first activation is harmless (still 200)", async () => {
    h.activate.mockResolvedValue({ status: "ALREADY_PAID" });
    const r = await send(event());
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ ok: true, result: "ALREADY_PAID" });
  });
  it("amount mismatch: 200 (so Razorpay stops retrying) but alerted, and nothing granted", async () => {
    h.activate.mockResolvedValue({ status: "AMOUNT_MISMATCH" });
    expect((await send(event())).status).toBe(200);
    expect(h.reportError).toHaveBeenCalled();
  });
  it("unknown order is acknowledged, not an error", async () => {
    h.activate.mockResolvedValue({ status: "UNKNOWN_ORDER" });
    expect((await send(event())).status).toBe(200);
  });
  it.each([
    ["a failed payment", { event: "payment.failed", payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 1, currency: "INR", status: "failed" } } } }],
    ["a capture event whose payment isn't 'captured'", { event: "payment.captured", payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 1, currency: "INR", status: "authorized" } } } }],
    ["an unrelated event", { event: "refund.created", payload: {} }],
    ["a malformed capture", { event: "payment.captured", payload: { payment: { entity: { id: 5 } } } }],
  ])("%s is acknowledged and ignored", async (_n, ev) => {
    const body = JSON.stringify(ev);
    const r = await send(body);
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ ignored: true });
    expect(h.activate).not.toHaveBeenCalled();
  });
  it("validly signed garbage is a 400, not a crash", async () => { expect((await send("not json")).status).toBe(400); });
  it("501 when payments aren't configured (the endpoint can't be used to probe)", async () => { expect((await send(event(), "x", ENV({ RAZORPAY_WEBHOOK_SECRET: "" }))).status).toBe(501); });
  it("the context is reset to non-privileged even if activation throws", async () => {
    h.activate.mockRejectedValue(new Error("db down"));
    await send(event()).catch(() => {});
    expect(h.setPriv.mock.calls.at(-1)![1]).toEqual({ system: false });
  });
});
