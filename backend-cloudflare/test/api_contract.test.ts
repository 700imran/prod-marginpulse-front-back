// Contract guard: every /api/v1 call the React app makes (frontend/src/api.js)
// must correspond to a route the Worker actually serves. This exists because
// the move off the old Go backend left several calls pointing at routes that
// were never ported (tenant audit log, bank re-verify, ROI path, insights
// path) — each one a feature that silently never loaded. It reads both sides
// from source, so it needs no server and fails the moment they drift.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const src = join(root, "src");
const apiJs = join(root, "..", "frontend", "src", "api.js");

function workerRoutes(): { method: string; pattern: RegExp; raw: string }[] {
  const index = readFileSync(join(src, "index.ts"), "utf8");
  const mounts = new Map<string, string>(); // route variable -> prefix
  for (const m of index.matchAll(/app\.route\("(\/api\/v1\/[^"]*)",\s*(\w+)\)/g)) mounts.set(m[2]!, m[1]!);
  const out: { method: string; pattern: RegExp; raw: string }[] = [];
  const add = (method: string, path: string) =>
    out.push({ method: method.toUpperCase(), raw: path, pattern: new RegExp("^" + path.replace(/:[A-Za-z_]+/g, "[^/]+") + "$") });
  for (const f of readdirSync(join(src, "routes"))) {
    const text = readFileSync(join(src, "routes", f), "utf8");
    for (const m of text.matchAll(/(\w+)\.(get|post|put|patch|delete)\(\s*"([^"]*)"/g)) {
      const prefix = mounts.get(m[1]!);
      if (prefix) add(m[2]!, prefix + (m[3] === "/" ? "" : m[3]!));
    }
  }
  return out;
}

function frontendCalls(): { method: string; path: string }[] {
  const text = readFileSync(apiJs, "utf8");
  const calls: { method: string; path: string }[] = [];
  for (const m of text.matchAll(/request\(\s*'(\w+)',\s*[`']([^`']+)[`']/g)) calls.push({ method: m[1]!.toUpperCase(), path: m[2]! });
  for (const m of text.matchAll(/fetch\(`\$\{BASE\}([^`]+)`(?:,\s*\{([^}]*)\})?/g)) {
    calls.push({ method: (/method:\s*'(\w+)'/.exec(m[2] ?? "")?.[1] ?? "GET").toUpperCase(), path: m[1]! });
  }
  return calls
    .map((c) => ({ method: c.method, path: c.path.split("?")[0]!.replace(/\$\{[^}]+\}/g, "x") }))
    .filter((c) => c.path.startsWith("/api/v1"));
}

describe("frontend ↔ Worker API contract", () => {
  const routes = workerRoutes();
  const calls = frontendCalls();

  it("the scanners actually found something (guards against a silently broken test)", () => {
    expect(routes.length).toBeGreaterThan(40);
    expect(calls.length).toBeGreaterThan(40);
  });

  it("every frontend API call has a matching Worker route", () => {
    const missing = calls.filter((c) => !routes.some((r) => r.method === c.method && r.pattern.test(c.path)));
    expect(missing.map((c) => `${c.method} ${c.path}`)).toEqual([]);
  });

  it("the specific routes that used to be missing now exist", () => {
    const has = (m: string, p: string) => routes.some((r) => r.method === m && r.pattern.test(p));
    expect(has("GET", "/api/v1/audit-log")).toBe(true);
    expect(has("POST", "/api/v1/bank-accounts/x/reverify")).toBe(true);
    expect(has("POST", "/api/v1/roi")).toBe(true);
    expect(has("GET", "/api/v1/reconciliation/dashboard-insights")).toBe(true);
    expect(has("GET", "/api/v1/reconciliation/dashboard-insight")).toBe(true);
  });

  it("the frontend's gated screens and the backend's feature table name exactly the same features", () => {
    const front = readFileSync(join(root, "..", "frontend", "src", "planLogic.js"), "utf8");
    const block = /NAV_FEATURE = \{([\s\S]*?)\};/.exec(front)?.[1] ?? "";
    const frontKeys = [...block.matchAll(/:\s*"([a-z_]+)"/g)].map((m) => m[1]!).sort();
    const backend = readFileSync(join(src, "billing", "plans.ts"), "utf8");
    const fblock = /export const FEATURES = \{([\s\S]*?)\} as const/.exec(backend)?.[1] ?? "";
    const backKeys = [...fblock.matchAll(/^\s*([a-z_]+):\s*\{/gm)].map((m) => m[1]!).sort();
    expect(frontKeys.length).toBeGreaterThan(4);
    expect(frontKeys).toEqual(backKeys);
  });

  it("the billing endpoints the pricing page uses exist", () => {
    const has = (m: string, p: string) => routes.some((r) => r.method === m && r.pattern.test(p));
    expect(has("GET", "/api/v1/billing/plans")).toBe(true);
    expect(has("POST", "/api/v1/billing/checkout")).toBe(true);
    expect(has("POST", "/api/v1/billing/verify")).toBe(true);
  });
});
