import type { MiddlewareHandler } from "hono";
import type { Env } from "../config";
import { checkRateLimit } from "../ratelimit";
import type { TenantContext } from "../auth/supabase";
import { apiError } from "../http";

// Route-specific limits. Login/register/refresh rate limits from the old
// ratelimit.go are gone — Supabase Auth enforces its own limits on those
// endpoints now, since the frontend calls Supabase directly for them.
export function rateLimit(bucket: string, limit: number, windowSeconds: number): MiddlewareHandler<{ Bindings: Env; Variables: { tenant?: TenantContext } }> {
  return async (c, next) => {
    const identifier = c.get("tenant")?.tenantId ?? c.req.header("CF-Connecting-IP") ?? "unknown";
    const { allowed, remaining } = await checkRateLimit(c.env, bucket, identifier, limit, windowSeconds);
    c.header("X-RateLimit-Remaining", String(remaining));
    if (!allowed) {
      return apiError(c, 429, "RATE_LIMITED", "rate limit exceeded, try again shortly");
    }
    await next();
  };
}
