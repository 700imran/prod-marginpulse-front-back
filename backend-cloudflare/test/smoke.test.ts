// The production smoke test (scripts/smoke.mjs), tested two ways:
//  1. against the REAL, complete Worker app (every middleware, every route) with
//     only the database/Redis swapped for stubs — it must pass;
//  2. against deliberately broken fake backends — it must FAIL, for each thing it
//     claims to check.
import { describe, it, expect, vi } from "vitest";
// @ts-expect-error — plain ESM script, no types
import { runSmoke, formatReport } from "../scripts/smoke.mjs";
import { REQUIRED_TABLES, REQUIRED_COLUMNS } from "../src/schemaCheck";

const h = vi.hoisted(() => ({ schemaOk: true }));
vi.mock("../src/db", () => ({
  getDb: () => {
    const tag = async () => [{ "?column?": 1 }];
    const allTrue: Record<string, boolean> = {};
    return Object.assign(tag, {
      end: async () => {},
      unsafe: async () => [Object.fromEntries([
        ...REQUIRED_TABLES.map((_, i) => [`t${i}`, h.schemaOk]),
        ...REQUIRED_COLUMNS.map((_, i) => [`c${i}`, h.schemaOk]),
        ["rls", true], ...Object.entries(allTrue),
      ])],
    });
  },
}));
vi.mock("../src/ratelimit", () => ({
  upstash: async () => "PONG", checkRateLimit: async () => ({ allowed: true }), checkAndIncrementAIBudget: async () => ({ allowed: true }),
}));
vi.mock("../src/monitoring", () => ({ reportError: async () => {} }));

import worker from "../src/index";

const BACKEND = "https://api.example.workers.dev";
const APP = "https://app.marginpulse.in";
const WORKERS_APP = "https://prod-marginpulse-frontend.imrankhan210r.workers.dev";
const env: any = {
  ENVIRONMENT: "production", HYPERDRIVE: { connectionString: "x" },
  FRONTEND_ORIGIN: APP, ALLOWED_ORIGINS: `${WORKERS_APP},https://marginpulse-app.vercel.app`,
  SUPABASE_URL: "https://nseurvhbqkdlemcfoixt.supabase.co", SUPABASE_JWT_SECRET: "s".repeat(32), FIELD_ENCRYPTION_KEY: "k".repeat(32),
};
const ctx: any = { waitUntil() {}, passThroughOnException() {} };
const realApp = (url: any, init: any) => (worker as any).fetch(new Request(url, init), env, ctx);

// A fake "frontend" site: HTML that references a bundle, and the bundle.
function withFrontends(inner: (u: string, i: any) => Promise<Response> | Response, bundle = `const API="${BACKEND}";`) {
  return async (url: string, init: any) => {
    const u = new URL(url);
    if ([APP, WORKERS_APP].includes(u.origin)) {
      if (u.pathname === "/") return new Response('<html><title>MarginPulse Pro</title><script defer src="/static/js/main.abc123.js"></script></html>', { headers: { "Content-Type": "text/html" } });
      if (u.pathname.startsWith("/static/js/main.")) return new Response(bundle);
    }
    return inner(url, init);
  };
}
const failedNames = (r: any) => r.results.filter((x: any) => !x.ok && !x.warn).map((x: any) => x.name);

describe("against the real app", () => {
  it("passes every unauthenticated check", async () => {
    const r = await runSmoke({ backendUrl: BACKEND, frontendUrls: [APP, WORKERS_APP], fetchImpl: withFrontends(realApp) });
    if (!r.ok) console.log(formatReport(r.results));
    expect(failedNames(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.results.length).toBeGreaterThan(15);
  });
  it("fails when the database schema doesn't match this build (the failure a bad deploy would show)", async () => {
    h.schemaOk = false;
    try {
      const r = await runSmoke({ backendUrl: BACKEND, fetchImpl: realApp });
      expect(r.ok).toBe(false);
      expect(failedNames(r).join()).toMatch(/health/);
      expect(r.results.find((x: any) => x.name.startsWith("health: /healthz")).detail).toMatch(/schema/i);
    } finally { h.schemaOk = true; }
  });
  it("fails if a frontend origin isn't allowed by the backend's CORS", async () => {
    const r = await runSmoke({ backendUrl: BACKEND, frontendUrls: ["https://not-configured.example.com"], fetchImpl: realApp });
    expect(failedNames(r).some((n: string) => n.startsWith("cors: preflight allowed for https://not-configured"))).toBe(true);
  });
});

// A configurable fake backend: start from "all good", then break one thing.
function fakeBackend(over: Partial<Record<string, (u: URL, init: any) => Response>> = {}) {
  const good = (u: URL, init: any): Response => {
    const origin = init.headers?.Origin;
    const cors: Record<string, string> = origin && [APP, WORKERS_APP].includes(origin) ? { "access-control-allow-origin": origin, "access-control-allow-headers": "Authorization,Content-Type", "access-control-max-age": "86400" } : {};
    const sec = { "x-content-type-options": "nosniff", "strict-transport-security": "max-age=63072000", "x-frame-options": "DENY" };
    if (init.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, ...sec } });
    if (u.pathname === "/healthz") return Response.json({ status: "ok", checks: { database: { ok: true }, schema: { ok: true }, rls: { ok: true }, redis: { ok: true } } }, { headers: sec });
    if (u.pathname === "/api/v1/roi") return Response.json({ ok: 1 }, { status: 400 });
    if (u.pathname === "/webhook/razorpay" || u.pathname === "/api/razorpay/webhook") return Response.json({ error: { code: "UNAUTHENTICATED" } }, { status: 401 });
    if (u.pathname.startsWith("/api/v1/definitely")) return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    return Response.json({ error: { code: "UNAUTHORIZED", message: "x" } }, { status: 401, headers: sec });
  };
  return (url: string, init: any) => {
    const path = new URL(url).pathname;
    const handler = over[`${init.method} ${path}`] ?? (init.method === "OPTIONS" ? undefined : over[path]) ?? good; // a plain path key never answers a CORS preflight
    return Promise.resolve(handler(new URL(url), init));
  };
}

describe("corsOrigins vs frontendUrls", () => {
  it("CORS can be tested without checking any frontend site (what the deploy gate does)", async () => {
    const r = await runSmoke({ backendUrl: BACKEND, corsOrigins: [APP, WORKERS_APP], fetchImpl: realApp });
    expect(r.ok).toBe(true);
    expect(r.results.some((x: any) => x.name.startsWith("cors: preflight allowed for"))).toBe(true);
    expect(r.results.some((x: any) => x.name.startsWith("frontend:"))).toBe(false);
  });
});

describe("fails on broken backends", () => {
  const run = (f: any, extra: any = {}) => runSmoke({ backendUrl: BACKEND, frontendUrls: [APP], fetchImpl: withFrontends(f), ...extra });

  it("sanity: the unbroken fake passes", async () => { expect((await run(fakeBackend())).ok).toBe(true); });
  it("an endpoint that is open without a token", async () => {
    const r = await run(fakeBackend({ "/api/v1/audit-log": () => Response.json({ items: [] }) }));
    expect(failedNames(r)).toContain("auth: GET /api/v1/audit-log requires a token (401)");
  });
  it("a CORS policy that allows everyone", async () => {
    const f = fakeBackend({ "OPTIONS /api/v1/reconciliation/dashboard-summary": (_u, i) => new Response(null, { status: 204, headers: { "access-control-allow-origin": i.headers.Origin, "access-control-allow-headers": "authorization" } }) });
    expect(failedNames(await run(f))).toContain("cors: an unlisted origin is refused");
  });
  it("a health endpoint that leaks connection details", async () => {
    const f = fakeBackend({ "/healthz": () => Response.json({ status: "ok", checks: { database: { ok: true, error: "connect ECONNREFUSED 10.0.0.5" }, schema: { ok: true } } }) });
    expect(failedNames(await run(f))[0]).toMatch(/health/);
  });
  it("a payment webhook that accepts unsigned requests", async () => {
    const r = await run(fakeBackend({ "POST /webhook/razorpay": () => Response.json({ ok: true }) }));
    expect(failedNames(r).some((n: string) => n.includes("Razorpay webhook rejects an unsigned"))).toBe(true);
  });
  it("billing endpoints that are open without a token", async () => {
    const r = await run(fakeBackend({ "GET /api/v1/billing/plans": () => Response.json({ plans: [] }) }));
    expect(failedNames(r)).toContain("auth: GET /api/v1/billing/plans requires a token (401)");
  });
  it("a frontend that reaches the backend through its custom domain is fine", async () => {
    const r = await runSmoke({ backendUrl: BACKEND, frontendUrls: [APP], fetchImpl: withFrontends(fakeBackend(), 'const API="https://api.marginpulse.in";') });
    expect(failedNames(r)).toEqual([]);
  });
  it("a 500 on the public ROI route", async () => {
    expect(failedNames(await run(fakeBackend({ "/api/v1/roi": () => new Response("boom", { status: 500 }) })))).toContain("public: POST /api/v1/roi never 5xx on empty input");
  });
  it("a frontend built without the backend's address (empty REACT_APP_API_URL)", async () => {
    const r = await runSmoke({ backendUrl: BACKEND, frontendUrls: [APP], fetchImpl: withFrontends(fakeBackend(), 'const API="";') });
    expect(failedNames(r)).toContain(`frontend: ${APP} is built to call this backend`);
  });
  it("a frontend that isn't the app", async () => {
    const r = await runSmoke({ backendUrl: BACKEND, frontendUrls: [APP], fetchImpl: async (u: string, i: any) => (new URL(u).origin === APP ? new Response("<html>parked domain</html>") : fakeBackend()(u, i)) });
    expect(failedNames(r)).toContain(`frontend: ${APP} serves the app`);
  });
  it("a backend that hangs (timeout)", async () => {
    const r = await runSmoke({ backendUrl: BACKEND, timeoutMs: 30, fetchImpl: (_u: string, init: any) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))) });
    expect(r.ok).toBe(false);
  });
  it("authenticated checks: pass when right, fail when the assistant's mutations are unexpectedly ON", async () => {
    const authed = (confirmStatus: number) => fakeBackend({
      "/api/v1/reconciliation/dashboard-summary": (_u, i) => (i.headers?.Authorization === "Bearer t" ? Response.json({ summaryMetrics: { totalUploadedDocuments: 3 }, plainEnglishInsight: "" }) : Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 })),
      "/api/v1/reconciliation/dashboard-insights": (_u, i) => (i.headers?.Authorization === "Bearer t" ? Response.json({ generatedAt: "now" }) : Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 })),
      "/api/v1/audit-log": (_u, i) => (i.headers?.Authorization === "Bearer t" ? Response.json({ items: [] }) : Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 })),
      "/api/v1/assistant/confirm": (_u, i) => (i.headers?.Authorization === "Bearer t" ? Response.json({}, { status: confirmStatus }) : Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 })),
    });
    const good = await run(authed(501), { token: "t" });
    if (!good.ok) console.log(formatReport(good.results.filter((x: any) => !x.ok)));
    expect(good.ok).toBe(true);
    const bad = await run(authed(200), { token: "t" });
    expect(failedNames(bad).some((n: string) => n.includes("assistant actions are OFF"))).toBe(true);
  });
});
