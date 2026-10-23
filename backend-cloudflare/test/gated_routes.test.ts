// Every route that belongs to a plan feature must actually be guarded — a feature
// table nobody enforces is just decoration. With enforcement on, a Free tenant
// must get 402 PLAN_REQUIRED on each; with it off (the default), none.
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

const h = vi.hoisted(() => ({ plan: "FREE" }));
vi.mock("../src/middleware/auth", () => ({
  requireAuth: async (c: any, next: any) => { c.set("tenant", { tenantId: "t", planTier: h.plan, ownerEmail: "o@x.in" }); c.set("sql", { unsafe: async () => [], begin: async () => [] }); c.set("requestId", "r"); await next(); },
}));
vi.mock("../src/middleware/rateLimit", () => ({ rateLimit: () => async (_c: any, n: any) => n() }));

import { gstRoutes } from "../src/routes/gst";
import { teamRoutes } from "../src/routes/team";
import { auditLogRoutes } from "../src/routes/auditLog";
import { settingsRoutes } from "../src/routes/settings";
import { integrationRoutes } from "../src/routes/integrations";
import { FEATURES, PLAN_LABELS } from "../src/billing/plans";

const app = () => {
  const a = new Hono<any>();
  a.route("/gst", gstRoutes); a.route("/team", teamRoutes); a.route("/audit-log", auditLogRoutes);
  a.route("/settings", settingsRoutes); a.route("/integrations", integrationRoutes);
  return a;
};
const call = (method: string, path: string, plan: string, flag?: string) => {
  h.plan = plan;
  return app().request(path, { method, headers: { "Content-Type": "application/json" }, body: method === "GET" ? undefined : "{}" }, { ENFORCE_PLAN_GATING: flag }, { waitUntil() {}, passThroughOnException() {} } as any);
};

const gated: [string, string, keyof typeof FEATURES][] = [
  ["GET", "/gst/vendor-status", "gst_sync"], ["GET", "/gst/itc-summary", "gst_sync"], ["POST", "/gst/sync", "gst_sync"],
  ["GET", "/team", "team"], ["POST", "/team/invite", "team"],
  ["GET", "/audit-log", "audit_log"],
  ["GET", "/settings/reconciliation", "recon_rules"], ["PATCH", "/settings/reconciliation", "recon_rules"],
  ["GET", "/settings/notifications", "notifications"], ["PATCH", "/settings/notifications", "notifications"],
  ["GET", "/settings/integrations", "integrations"], ["PATCH", "/settings/integrations", "integrations"],
  ["GET", "/integrations", "integrations"], ["POST", "/integrations/slack/connect", "integrations"],
];

describe("plan gating on real routes", () => {
  it.each(gated)("%s %s → 402 PLAN_REQUIRED for a Free tenant when enforcing", async (m, p, f) => {
    const r = await call(m, p, "FREE", "true");
    expect(r.status).toBe(402);
    const b = (await r.json()) as any;
    expect(b.error.code).toBe("PLAN_REQUIRED");
    expect(b.error.details.required_plan_label).toBe(PLAN_LABELS[FEATURES[f].minPlan]);
  });
  it.each(gated)("%s %s → never 402 PLAN_REQUIRED when enforcement is off (default)", async (m, p) => {
    for (const flag of [undefined, "false"]) {
      const r = await call(m, p, "FREE", flag);
      const b: any = await r.json().catch(() => ({}));
      expect(b?.error?.code).not.toBe("PLAN_REQUIRED");
    }
  });
  it.each(gated)("%s %s → not blocked for an Enterprise tenant when enforcing", async (m, p) => {
    const b: any = await (await call(m, p, "ENTERPRISE", "true")).json().catch(() => ({}));
    expect(b?.error?.code).not.toBe("PLAN_REQUIRED");
  });
  it("the Slack OAuth callback stays reachable (it's an unauthenticated redirect from Slack, not a user action)", async () => {
    const b: any = await (await call("GET", "/integrations/slack/callback", "FREE", "true")).text().then((t) => { try { return JSON.parse(t); } catch { return {}; } });
    expect(b?.error?.code).not.toBe("PLAN_REQUIRED");
  });
});
