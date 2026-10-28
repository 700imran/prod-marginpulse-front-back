import { Hono, type Context, type MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { maybeFlush, safeLabel } from "./metrics";
import { registry, emit, setSink } from "./events";
export { registry, emit };

const VIEWS = new Set(["dashboard", "documents", "gst", "profile", "taxbank", "recon", "api", "notify", "security", "billing", "team", "admin", "roi", "auditlog"]);
const VITALS = new Set(["FCP", "LCP", "CLS", "INP", "TTFB", "APP_READY"]);
const ERR_KINDS = new Set(["js", "promise", "render"]);
const hex = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hashTenant(env: Partial<Env>, id: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${(env as { TELEMETRY_SALT?: string }).TELEMETRY_SALT ?? "mp"}:${id}`));
  return [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function routeLabel(c: Parameters<MiddlewareHandler>[0]): string {
  try {
    const m = matchedRoutes(c).filter((r) => r.method !== "ALL" && r.path !== "/*" && r.path !== "*");
    const p = m[m.length - 1]?.path;
    if (p) return p;
  } catch { /* fall through */ }
  return "unmatched"; // 404s: never use the raw path (unbounded cardinality / PII risk)
}

export const telemetry: MiddlewareHandler<{ Bindings: Env; Variables: { tenant?: TenantContext; requestId?: string } }> = async (c, next) => {
  setSink(c.env);
  const t0 = Date.now();
  try {
    await next();
  } finally {
    try {
      const method = c.req.method;
      const path = new URL(c.req.url).pathname;
      if (method !== "OPTIONS" && path !== "/health") {
        const status = c.res.status;
        const ms = Date.now() - t0;
        const route = routeLabel(c);
        const tenant = c.get("tenant");
        const plan = safeLabel(tenant?.planTier?.toLowerCase(), "anon");
        registry.observe("http.server.request.duration", "s", ms / 1000, { "http.request.method": method, "http.route": route, "http.response.status_code": String(status), plan });

        const colo = safeLabel((c.req.raw as unknown as { cf?: { colo?: string } }).cf?.colo, "");
        const tenantHash = tenant ? await hashTenant(c.env, tenant.tenantId) : "";
        const requestId = c.get("requestId") ?? "";
        console.log(JSON.stringify({ level: status >= 500 ? "error" : status >= 400 ? "warn" : "info", msg: "http_request", requestId, method, route, status, ms, plan, tenant: tenantHash, colo }));

        try { c.env.METRICS?.writeDataPoint({ indexes: [route], blobs: [method, String(status), plan, colo], doubles: [ms] }); } catch { /* ignore */ }

        const rate = Number((c.env as unknown as { TRACE_SAMPLE_RATE?: string }).TRACE_SAMPLE_RATE ?? "0.1");
        if (status >= 500 || ms > 1000 || Math.random() < rate) {
          registry.addSpan({ traceId: hex(16), spanId: hex(8), name: `${method} ${route}`, startMs: t0, endMs: t0 + ms, error: status >= 500,
            attrs: { "http.request.method": method, "http.route": route, "http.response.status_code": status, "mp.request_id": requestId, "mp.tenant": tenantHash, "mp.plan": plan, "mp.colo": colo } });
        }
        const flush = maybeFlush(registry, c.env);
        try { c.executionCtx.waitUntil(flush); } catch { void flush; }
      }
    } catch (e) {
      console.warn(JSON.stringify({ level: "warn", msg: "telemetry_error", error: (e as Error).message }));
    }
  }
};

// ── browser (RUM) ingest ────────────────────────────────────────────────────
// Authenticated, size-capped, allow-listed: the browser can only report known metric
// names for known screens, so it cannot inject arbitrary labels or PII.
const scrub = (s: string) => s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]").replace(/https?:\/\/\S+/g, "[url]").replace(/\d{6,}/g, "[n]").replace(/[\r\n\t]/g, " ").slice(0, 160);

export const telemetryRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext } }>();
telemetryRoutes.use("*", requireAuth);
export const telemetryIngest = async (c: Context<{ Bindings: Env }>) => {
  const text = await c.req.text();
  if (text.length > 8192) return c.json({ error: "payload too large" }, 413);
  let body: { events?: unknown };
  try { body = JSON.parse(text); } catch { return c.json({ error: "invalid json" }, 400); }
  if (!Array.isArray(body.events)) return c.json({ error: "events must be an array" }, 400);
  let accepted = 0;
  for (const raw of body.events.slice(0, 25)) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const view = typeof e.view === "string" && VIEWS.has(e.view) ? e.view : "other";
    const v = typeof e.v === "number" && Number.isFinite(e.v) && e.v >= 0 && e.v <= 120_000 ? e.v : null;
    if (e.t === "vital" && typeof e.name === "string" && VITALS.has(e.name) && v !== null) {
      registry.observe("marginpulse.web.vital", "ms", v, { name: e.name, view }); accepted++;
    } else if (e.t === "feature" && v !== null) {
      registry.observe("marginpulse.feature.load", "ms", v, { view, temp: e.temp === "warm" ? "warm" : "cold" }); accepted++;
    } else if (e.t === "error" && typeof e.kind === "string" && ERR_KINDS.has(e.kind)) {
      emit("js_error", { kind: e.kind, view });
      console.warn(JSON.stringify({ level: "warn", msg: "client_error", kind: e.kind, view, detail: scrub(String(e.msg ?? "")) })); accepted++;
    }
  }
  const flush = maybeFlush(registry, c.env);
  try { c.executionCtx.waitUntil(flush); } catch { void flush; }
  return c.body(null, 204);
};
telemetryRoutes.post("/", telemetryIngest as never);
