import { emit } from "../observability/events";
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
        emit("rate_limited", { limiter: bucket });
        return c.json({ error: "rate limit exceeded, try again shortly" }, 429);
      }
    } catch (e) {
      emit("ratelimit_backend_error", { limiter: bucket });
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

// Shared counter: returns the new count in the current window and when the window resets.
function hit(key: string, windowSeconds: number): { n: number; reset: number } {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) {
    if (buckets.size > 5000) for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
    b = { n: 0, reset: now + windowSeconds * 1000 };
    buckets.set(key, b);
  }
  b.n++;
  return b;
}

// Per-IP ceiling. Generous on purpose: a whole accounting office shares ONE NAT'd address, and a single dashboard
// load fans out into ~10 API calls — a tight per-IP limit throttled legitimate users first.
export function isolateRateLimit(limit: number, windowSeconds: number): MiddlewareHandler {
  return async (c, next) => {
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const b = hit(`${limit}:${windowSeconds}:${ip}`, windowSeconds); // each limiter has its OWN counter (they used to share one per IP)
    if (b.n > limit) {
      c.header("Retry-After", String(Math.ceil((b.reset - Date.now()) / 1000)));
      emit("rate_limited", { limiter: "isolate" });
      return c.json({ error: "rate limit exceeded, try again shortly" }, 429);
    }
    await next();
  };
}

// Per-ACCOUNT budget, applied by requireAuth after the tenant is known. This is the abuse control that actually
// matches the unit of trust (one paying account), independent of how many people share an IP.
// Returns true when the request is allowed.
export function userRateLimit(tenantId: string, limit = 900, windowSeconds = 60): { allowed: boolean; retryAfter: number } {
  const b = hit(`user:${limit}:${windowSeconds}:${tenantId}`, windowSeconds);
  return { allowed: b.n <= limit, retryAfter: Math.max(1, Math.ceil((b.reset - Date.now()) / 1000)) };
}
