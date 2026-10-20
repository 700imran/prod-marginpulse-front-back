// The dashboard used to call the AI model and spend a credit on EVERY visit,
// blocking the whole response on it. These pin the new behaviour: a fast
// numbers-only mode, and a per-tenant cache so unchanged numbers cost nothing.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const h = vi.hoisted(() => ({
  redis: new Map<string, string>(),
  redisDown: false,
  generate: vi.fn(),
  counts: { total: 10, reconciled: 7 },
  order: [] as string[],
}));

vi.mock("../src/ratelimit", () => ({
  upstash: async (_e: unknown, ...cmd: (string | number)[]) => {
    if (h.redisDown) throw new Error("redis down");
    if (cmd[0] === "GET") return h.redis.get(String(cmd[1])) ?? null;
    if (cmd[0] === "SET") { h.redis.set(String(cmd[1]), String(cmd[2])); return "OK"; }
    throw new Error("unexpected " + cmd[0]);
  },
  checkRateLimit: async () => ({ allowed: true }), checkAndIncrementAIBudget: async () => ({ allowed: true }),
}));
vi.mock("../src/pipelines/insights", () => ({ generateInsight: h.generate }));
vi.mock("../src/repository/documents", () => ({
  countDocumentsByTenant: async () => { h.order.push("count"); return h.counts.total; },
  countDocumentsByStatus: async () => { h.order.push("status"); return h.counts.reconciled; },
  listByGSTStatus: async () => { h.order.push("gst"); return []; },
}));
vi.mock("../src/repository/anomalies", () => ({ listAnomalies: async () => { h.order.push("anom"); return []; } }));
vi.mock("../src/middleware/auth", () => ({
  requireAuth: async (c: any, next: any) => { c.set("tenant", { tenantId: (globalThis as any).__tid ?? "t1" }); c.set("sql", {}); await next(); },
}));

import { buildDashboardSummary } from "../src/pipelines/dashboard";
import { reconciliationRoutes } from "../src/routes/reconciliation";

const tenant = (id: string) => ({ tenantId: id }) as any;
const env = {} as any;

beforeEach(() => {
  h.redis.clear(); h.redisDown = false; h.order.length = 0;
  h.counts = { total: 10, reconciled: 7 };
  h.generate.mockReset().mockResolvedValue("You have 3 gaps.");
  (globalThis as any).__tid = "t1";
});

describe("buildDashboardSummary", () => {
  it("includeInsight:false never touches the model or the cache", async () => {
    const s = await buildDashboardSummary({} as any, env, tenant("t1"), { includeInsight: false });
    expect(s.plainEnglishInsight).toBe("");
    expect(s.summaryMetrics.totalUploadedDocuments).toBe(10);
    expect(h.generate).not.toHaveBeenCalled();
    expect(h.redis.size).toBe(0);
  });

  it("first visit generates and caches; an unchanged repeat visit costs nothing", async () => {
    await buildDashboardSummary({} as any, env, tenant("t1"));
    expect(h.generate).toHaveBeenCalledTimes(1);
    const again = await buildDashboardSummary({} as any, env, tenant("t1"));
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(again.plainEnglishInsight).toBe("You have 3 gaps.");
  });

  it("changed numbers regenerate", async () => {
    await buildDashboardSummary({} as any, env, tenant("t1"));
    h.counts = { total: 11, reconciled: 7 };
    await buildDashboardSummary({} as any, env, tenant("t1"));
    expect(h.generate).toHaveBeenCalledTimes(2);
  });

  it("the cache is per tenant: identical numbers for another tenant is a miss", async () => {
    await buildDashboardSummary({} as any, env, tenant("t1"));
    await buildDashboardSummary({} as any, env, tenant("t2"));
    expect(h.generate).toHaveBeenCalledTimes(2);
    expect([...h.redis.keys()].every((k) => /^insight:v1:t[12]:/.test(k))).toBe(true);
  });

  it("Redis down: still returns the insight, never throws", async () => {
    h.redisDown = true;
    const s = await buildDashboardSummary({} as any, env, tenant("t1"));
    expect(s.plainEnglishInsight).toBe("You have 3 gaps.");
  });

  it("issues all reads without waiting for each other (pipelined, not serial)", async () => {
    await buildDashboardSummary({} as any, env, tenant("t1"), { includeInsight: false });
    expect(h.order.sort()).toEqual(["anom", "count", "gst", "gst", "status"]);
  });
});

describe("routes", () => {
  const app = () => { const a = new Hono<any>(); a.route("/r", reconciliationRoutes); return a; };
  it("GET dashboard-summary?insight=false is numbers only", async () => {
    const r = await app().request("/r/dashboard-summary?insight=false", {}, env);
    expect((await r.json() as any).plainEnglishInsight).toBe("");
    expect(h.generate).not.toHaveBeenCalled();
  });
  it("GET dashboard-summary without the flag is unchanged (still includes the insight)", async () => {
    const r = await app().request("/r/dashboard-summary", {}, env);
    expect((await r.json() as any).plainEnglishInsight).toBe("You have 3 gaps.");
  });
  it("GET dashboard-insight returns only the paragraph", async () => {
    const r = await app().request("/r/dashboard-insight", {}, env);
    expect(await r.json()).toEqual({ plainEnglishInsight: "You have 3 gaps." });
  });
});
