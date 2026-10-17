import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import { upstash } from "../ratelimit";

export const healthRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql } }>();

// GET /healthz — a real dependency check, not a static "ok". Point an
// uptime monitor (Cloudflare's own, UptimeRobot, whatever) at this
// rather than just confirming the Worker itself is reachable, which
// tells you nothing about whether it can actually serve a request.
//
// Postgres is "critical": almost no endpoint works without it, so its
// failure makes the overall response a 503. Upstash Redis backs rate
// limiting, OAuth state, and the AI daily budget guard — all of which
// degrade (see each call site's own fallback) rather than break outright
// if Redis is briefly unavailable, so it's reported but doesn't flip the
// overall status.
healthRoutes.get("/healthz", async (c) => {
  const checks: Record<string, { ok: boolean; error?: string }> = {};

  try {
    await c.get("sql")`select 1`;
    checks.database = { ok: true };
  } catch (e) {
    checks.database = { ok: false, error: (e as Error).message };
  }

  try {
    await upstash(c.env, "PING");
    checks.redis = { ok: true };
  } catch (e) {
    checks.redis = { ok: false, error: (e as Error).message };
  }

  const critical = checks.database?.ok;
  return c.json(
    { status: critical ? "ok" : "degraded", environment: c.env.ENVIRONMENT, checks },
    critical ? 200 : 503,
  );
});
