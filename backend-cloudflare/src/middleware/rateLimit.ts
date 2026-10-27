import type { MiddlewareHandler } from "hono";
import type { Env } from "../config";
import { checkRateLimit } from "../ratelimit";
import type { TenantContext } from "../auth/supabase";

// Fixed-window limiter. Keyed by tenant when authenticated, else by client IP.
// failClosed=true (money / auth-adjacent endpoints) rejects if the limiter's
// backing store is down; otherwise it fails open so an Upstash outage can't
// take the whole product down (the failure is logged).
export function rateLimit(bucket: string, limit: number, windowSeconds: number, opts: { failClosed?: boolean } = {}): MiddlewareHandler<{ Bindings: Env; Variables: { tenant?: TenantContext } }> {
  return async (c, next) => {
    const identifier = c.get("tenant")?.tenantId ?? c.req.header("CF-Connecting-IP") ?? "unknown";
    try {
      const { allowed, remaining } = await checkRateLimit(c.env, bucket, identifier, limit, windowSeconds);
      c.header("X-RateLimit-Remaining", String(remaining));
      if (!allowed) {
        c.header("Retry-After", String(windowSeconds));
        return c.json({ error: "rate limit exceeded, try again shortly" }, 429);
      }
    } catch (e) {
      console.error("ratelimit_backend_error", { bucket, error: (e as Error).message });
      if (opts.failClosed) return c.json({ error: "service temporarily unavailable" }, 503);
    }
    await next();
  };
}

// Best-effort per-isolate limiter: zero network cost, so it can sit on EVERY
// request without adding latency. It bounds a single abusive client hammering
// one edge location; the Upstash-backed limiter above covers global/sensitive paths.
const buckets = new Map<string, { n: number; reset: number }>();
export function isolateRateLimit(limit: number, windowSeconds: number): MiddlewareHandler {
  return async (c, next) => {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b || now > b.reset) {
      if (buckets.size > 5000) for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
      b = { n: 0, reset: now + windowSeconds * 1000 };
      buckets.set(ip, b);
    }
    if (++b.n > limit) {
      c.header("Retry-After", String(Math.ceil((b.reset - now) / 1000)));
      return c.json({ error: "rate limit exceeded, try again shortly" }, 429);
    }
    await next();
  };
}
