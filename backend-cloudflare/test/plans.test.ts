import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import {
  FEATURES, PLAN_ORDER, PLAN_LABELS, planAllows, planRank, gatingEnforced, planPricesInr, planCatalog, paymentsConfigured, isPaidPlan,
  type FeatureKey, type PlanTier,
} from "../src/billing/plans";
import { requireFeature } from "../src/billing/featureGate";

describe("entitlements", () => {
  const matrix: [FeatureKey, PlanTier, boolean][] = [
    ["gst_sync", "FREE", false], ["gst_sync", "STARTER", true], ["gst_sync", "GROWTH", true], ["gst_sync", "ENTERPRISE", true],
    ["recon_rules", "FREE", false], ["recon_rules", "STARTER", true],
    ["audit_log", "FREE", false], ["audit_log", "STARTER", true],
    ["integrations", "FREE", false], ["integrations", "STARTER", false], ["integrations", "GROWTH", true], ["integrations", "ENTERPRISE", true],
    ["notifications", "STARTER", false], ["notifications", "GROWTH", true],
    ["team", "STARTER", false], ["team", "GROWTH", true], ["team", "ENTERPRISE", true],
  ];
  it.each(matrix)("%s on %s → %s", (f, p, ok) => expect(planAllows(p, f)).toBe(ok));
  it("an unknown or garbage plan is treated as FREE (never as more)", () => {
    for (const p of ["", "pro", "ADMIN", "enterprise", "__proto__"]) expect(planAllows(p, "gst_sync")).toBe(false);
    expect(planRank("nonsense")).toBe(0);
  });
  it("the ladder is Free → Starter → Pro → Enterprise (the Billing page's names) and every feature's minimum is a real plan", () => {
    expect(PLAN_ORDER.map((p) => PLAN_LABELS[p])).toEqual(["Free", "Starter", "Pro", "Enterprise"]);
    for (const f of Object.values(FEATURES)) expect(PLAN_ORDER).toContain(f.minPlan);
  });
  it("badges come from one table: Starter-tier features say Starter, Pro-tier features say Pro", () => {
    const badge = (k: FeatureKey) => PLAN_LABELS[FEATURES[k].minPlan as PlanTier];
    expect(["gst_sync", "recon_rules", "audit_log"].map((k) => badge(k as FeatureKey))).toEqual(["Starter", "Starter", "Starter"]);
    expect(["integrations", "notifications", "team"].map((k) => badge(k as FeatureKey))).toEqual(["Pro", "Pro", "Pro"]);
  });
});

describe("config parsing", () => {
  it("gating is on only for exactly 'true'", () => {
    for (const v of [undefined, "", "false", "TRUE", "1", "yes"]) expect(gatingEnforced({ ENFORCE_PLAN_GATING: v })).toBe(false);
    expect(gatingEnforced({ ENFORCE_PLAN_GATING: "true" })).toBe(true);
  });
  it("prices: only positive whole rupees for real paid plans are accepted", () => {
    expect(planPricesInr({ PLAN_PRICES_INR: '{"STARTER":999,"GROWTH":2499}' })).toEqual({ STARTER: 999, GROWTH: 2499 });
    for (const bad of [undefined, "", "not json", "[]", "null", '{"FREE":0}', '{"STARTER":0}', '{"STARTER":-5}', '{"STARTER":9.5}', '{"STARTER":"999"}', '{"HACKER":1}', '{"STARTER":99999999999}'])
      expect(planPricesInr({ PLAN_PRICES_INR: bad })).toEqual({});
  });
  it("a plan is purchasable only with all three payment secrets AND a price", () => {
    const base = { PLAN_PRICES_INR: '{"STARTER":999}', RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s", RAZORPAY_WEBHOOK_SECRET: "w" };
    const get = (e: any, id: string) => planCatalog(e).find((p) => p.id === id)!;
    expect(get(base, "STARTER").purchasable).toBe(true);
    expect(get(base, "GROWTH").purchasable).toBe(false);          // no price configured
    expect(get(base, "FREE").purchasable).toBe(false);
    expect(get({ ...base, RAZORPAY_WEBHOOK_SECRET: "" }, "STARTER").purchasable).toBe(false);
    expect(paymentsConfigured({})).toBe(false);
    expect(get({}, "STARTER").priceInr).toBeNull();               // no invented prices
  });
  it("the catalogue lists each plan's features and credits", () => {
    const cat = planCatalog({});
    expect(cat.find((p) => p.id === "FREE")!.features).toEqual([]);
    expect(cat.find((p) => p.id === "STARTER")!.features.sort()).toEqual(["audit_log", "gst_sync", "recon_rules"]);
    expect(cat.find((p) => p.id === "ENTERPRISE")!.features.length).toBe(Object.keys(FEATURES).length);
    expect(cat.find((p) => p.id === "GROWTH")!.monthlyCredits).toBeGreaterThan(cat.find((p) => p.id === "STARTER")!.monthlyCredits);
  });
  it("isPaidPlan", () => { expect(isPaidPlan("STARTER")).toBe(true); expect(isPaidPlan("FREE")).toBe(false); expect(isPaidPlan("x")).toBe(false); });
});

describe("requireFeature middleware", () => {
  const run = async (feature: FeatureKey, plan: string, flag?: string) => {
    const app = new Hono<any>();
    app.use("*", async (c, next) => { c.set("tenant", { planTier: plan }); c.set("requestId", "r1"); await next(); });
    app.use("*", requireFeature(feature));
    app.get("/x", (c) => c.json({ ok: true }));
    return app.request("/x", {}, { ENFORCE_PLAN_GATING: flag });
  };
  it("flag off: everyone passes (shipping the code changes nothing)", async () => {
    for (const p of PLAN_ORDER) expect((await run("team", p)).status).toBe(200);
  });
  it("flag on: below the required plan → 402 PLAN_REQUIRED with what to upgrade to", async () => {
    const r = await run("gst_sync", "FREE", "true");
    expect(r.status).toBe(402);
    const b = (await r.json()) as any;
    expect(b.error.code).toBe("PLAN_REQUIRED");
    expect(b.error.details).toMatchObject({ feature: "gst_sync", required_plan: "STARTER", required_plan_label: "Starter", current_plan: "FREE" });
  });
  it("flag on: at or above the required plan → allowed", async () => {
    expect((await run("gst_sync", "STARTER", "true")).status).toBe(200);
    expect((await run("team", "GROWTH", "true")).status).toBe(200);
    expect((await run("team", "ENTERPRISE", "true")).status).toBe(200);
  });
  it("flag on: Starter is not enough for a Pro-tier feature", async () => {
    const r = await run("integrations", "STARTER", "true");
    expect(r.status).toBe(402);
    expect(((await r.json()) as any).error.details.required_plan_label).toBe("Pro");
  });
  it("an unknown plan string is blocked, not waved through", async () => {
    expect((await run("gst_sync", "SUPERUSER", "true")).status).toBe(402);
  });
});
