import type { MiddlewareHandler } from "hono";
import type { Env } from "../config";
import { emit } from "../observability/events";
import { retryAfterSeconds } from "../lib/dbErrors";

// Load shedding for the expensive endpoints (file upload, dataset import, reconcile, export).
//
// Every one of those holds a database connection for a long time. Under a surge, accepting all of them just makes
// every request slow until the platform times out, and the connection pool (Hyperdrive ≈20 origin connections on the
// free plan, ≈100 paid) starves the cheap requests too — the dashboard stops loading for everyone. Refusing the excess
// IMMEDIATELY with 503 + Retry-After keeps the cheap endpoints healthy and tells well-behaved clients when to return.
//
// The counter is per isolate (a Worker isolate has no shared memory with its siblings), so this bounds how hard ONE
// isolate can hammer the database; it is a safety valve, not a global rate limit (docs/CAPACITY.md explains the gap).
const inflight = new Map<string, number>();
const DEFAULT_LIMIT = 8;

export function heavyLimit(env: Pick<Env, "MAX_HEAVY_INFLIGHT">): number {
  const raw = env.MAX_HEAVY_INFLIGHT;
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_LIMIT; // 0 switches it off
}

export function shedHeavy(name: string): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const limit = heavyLimit(c.env);
    if (limit === 0) return next();
    const n = inflight.get(name) ?? 0;
    if (n >= limit) {
      emit("shed", { route: name });
      const wait = retryAfterSeconds(2, 4);
      c.header("Retry-After", String(wait));
      return c.json({ error: "We're handling a lot of uploads right now. Please retry in a few seconds.", code: "BUSY", retryable: true, retryAfterSeconds: wait }, 503);
    }
    inflight.set(name, n + 1);
    try { await next(); } finally { inflight.set(name, Math.max(0, (inflight.get(name) ?? 1) - 1)); }
  };
}

export const _inflightForTests = () => Object.fromEntries(inflight);
