import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import { emit } from "../observability/events";
import { allowedOrigins, trackingOrigins } from "../middleware/security";
import { bucketCity, isLikelyBot, parseUserAgent, resolveVisitorIdentity, truncateIp } from "../pipelines/visitors";
import { eraseVisitor, upsertVisit } from "../repository/visitors";

// Consent-gated first-party visitor analytics for the marketing site and the app.
//   POST   /api/v1/track/visit    { consent: true, visitorId | requestId }   → counted once per 30-min session
//   DELETE /api/v1/track/visitor  { visitorId | requestId }                  → erase me (right to withdraw)
// Public and credential-less by design (see corsMiddleware): no cookies, no Authorization header, nothing that ties a
// visitor to a tenant. Telemetry must never break a page, so every failure after validation answers 202, never 5xx.
export const trackRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql } }>();

export function siteFor(env: Pick<Env, "TRACKING_ORIGINS" | "FRONTEND_ORIGIN">, origin: string | undefined): "app" | "marketing" | null {
  if (!origin) return null;
  const o = origin.replace(/\/$/, "");
  if (trackingOrigins(env).includes(o)) return "marketing";
  if (allowedOrigins(env).includes(o)) return "app";
  return null;
}

async function readBody(c: { req: { text(): Promise<string> } }): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: 400 | 413; error: string }> {
  const text = await c.req.text();
  if (text.length > 2048) return { ok: false, status: 413, error: "payload too large" };
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return { ok: true, body: v as Record<string, unknown> };
  } catch { /* fallthrough */ }
  return { ok: false, status: 400, error: "invalid json" };
}

trackRoutes.post("/visit", async (c) => {
  const site = siteFor(c.env, c.req.header("Origin"));
  if (!site) { emit("visit", { site: "unknown", outcome: "origin_rejected" }); return c.json({ error: "origin not allowed" }, 403); }
  const parsed = await readBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  if (parsed.body.consent !== true) { emit("visit", { site, outcome: "no_consent" }); return c.json({ error: "consent required" }, 400); }

  const ua = c.req.header("User-Agent") ?? "";
  const cf = (c.req.raw as unknown as { cf?: Record<string, unknown> }).cf as { city?: string; country?: string; botManagement?: { score?: number; verifiedBot?: boolean } } | undefined;
  if (isLikelyBot(ua, cf)) { emit("visit", { site, outcome: "bot" }); return c.json({ ok: true, counted: false }, 202); }

  const ip = c.req.header("CF-Connecting-IP") ?? null;
  const id = await resolveVisitorIdentity(c.env, parsed.body, ip);
  if (!id.ok) {
    if (id.error === "verification unavailable") { emit("visit", { site, outcome: "verify_unavailable" }); return c.json({ ok: true, counted: false }, 202); }
    emit("visit", { site, outcome: id.error === "unverified" ? "unverified" : "bad_id" });
    return c.json({ error: id.error }, id.error === "unverified" ? 403 : 400);
  }

  const info = parseUserAgent(ua);
  try {
    const r = await upsertVisit(c.get("sql"), {
      site, visitorId: id.id, idSource: id.source,
      ip: truncateIp(ip), city: bucketCity(cf?.city), country: typeof cf?.country === "string" && /^[A-Z]{2}$/.test(cf.country) ? cf.country : null,
      device: info.device, browser: info.browser, os: info.os,
    });
    emit("visit", { site, outcome: r.inserted ? "new" : "returning" });
    return c.json({ ok: true, counted: true, newVisitor: r.inserted, visits: r.visits }, 202);
  } catch (e) {
    emit("visit", { site, outcome: "db_error" });
    console.error(JSON.stringify({ level: "error", msg: "visit_store_failed", site, error: (e as Error).message }));
    return c.json({ ok: true, counted: false }, 202);
  }
});

trackRoutes.delete("/visitor", async (c) => {
  const site = siteFor(c.env, c.req.header("Origin"));
  if (!site) return c.json({ error: "origin not allowed" }, 403);
  const parsed = await readBody(c);
  if (!parsed.ok) return c.json({ error: parsed.error }, parsed.status);
  const id = await resolveVisitorIdentity(c.env, parsed.body, c.req.header("CF-Connecting-IP") ?? null);
  if (!id.ok) return c.json({ error: id.error }, id.error === "verification unavailable" ? 503 : id.error === "unverified" ? 403 : 400);
  try {
    const erased = await eraseVisitor(c.get("sql"), id.id);
    emit("visit", { site, outcome: "erased" });
    return c.json({ ok: true, erased });
  } catch (e) {
    console.error(JSON.stringify({ level: "error", msg: "visit_erase_failed", error: (e as Error).message }));
    return c.json({ error: "could not erase right now, please retry" }, 503);
  }
});
