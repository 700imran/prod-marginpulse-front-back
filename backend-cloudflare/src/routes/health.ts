import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import { upstash } from "../ratelimit";
import { checkSchema } from "../schemaCheck";

export const healthRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql } }>();

// GET /healthz — a real dependency check, not a static "ok". Point an
// uptime monitor (Cloudflare's own, UptimeRobot, whatever) at this
// rather than just confirming the Worker itself is reachable, which
// tells you nothing about whether it can actually serve a request.
//
// Postgres is "critical": almost no endpoint works without it, so its
// failure makes the overall response a 503 — and so does a database whose
// schema doesn't match this build (checks.schema). checks.rls is reported but
// not critical. Upstash Redis backs rate
// limiting, OAuth state, and the AI daily budget guard — all of which
// degrade (see each call site's own fallback) rather than break outright
// if Redis is briefly unavailable, so it's reported but doesn't flip the
// overall status.
healthRoutes.get("/healthz", async (c) => {
  const checks: Record<string, { ok: boolean }> = {};

  try {
    await c.get("sql")`select 1`;
    checks.database = { ok: true };
  } catch (e) {
    // The error text stays in the logs, not the response: this endpoint is
    // unauthenticated and polled by external pingers, and driver messages can
    // include hostnames or connection details.
    console.error("healthz_database_error", { message: (e as Error).message });
    checks.database = { ok: false };
  }

  // Only meaningful if the database answered. "ok" means every table/column this
  // build needs exists; names of anything missing go to the logs, not the response.
  if (checks.database?.ok) {
    try {
      const schema = await checkSchema(c.get("sql"));
      checks.schema = { ok: schema.ok };
      checks.rls = { ok: schema.rlsEnabled };
      if (!schema.ok) console.error("healthz_schema_mismatch", { missing: schema.missing });
      if (!schema.rlsEnabled) console.error("healthz_rls_not_enabled");
    } catch (e) {
      console.error("healthz_schema_error", { message: (e as Error).message });
      checks.schema = { ok: false };
    }
  }

  try {
    await upstash(c.env, "PING");
    checks.redis = { ok: true };
  } catch (e) {
    console.error("healthz_redis_error", { message: (e as Error).message });
    checks.redis = { ok: false };
  }

  const critical = checks.database?.ok && checks.schema?.ok;
  return c.json(
    { status: critical ? "ok" : "degraded", environment: c.env.ENVIRONMENT, checks },
    critical ? 200 : 503,
  );
});
