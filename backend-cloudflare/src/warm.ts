// Keep-warm tick. Runs from the 5-minute cron in wrangler.toml (and nothing
// else): a trivial round trip to each dependency so the path a real request
// takes — Hyperdrive's pooled connection, the Supabase compute behind it,
// Upstash — stays warm and, as a side benefit, counts as activity for
// Supabase's free-tier inactivity pause.
//
// What this does NOT do: warm the Worker itself. Workers start in
// milliseconds and have no meaningful cold start; a cron invocation isn't
// guaranteed to share an isolate with later HTTP requests anyway. The real
// "first request is slow" cost on this stack is the database/Redis behind
// the Worker, and that is what this touches.
//
// Deliberately tenant-blind: `select 1` reads no table, so no RLS context
// (setTenantContext / system_context) is needed or set. Never add tenant
// data access here — this handler runs every 5 minutes.
import type { Env } from "./config";
import { getDb } from "./db";
import { upstash } from "./ratelimit";

// Must match the entry in wrangler.toml's [triggers] crons, character for
// character: index.ts uses it to tell this tick apart from the daily sweep.
export const KEEP_WARM_CRON = "*/5 * * * *";

export interface WarmResult {
  database: { ok: boolean; ms: number };
  redis: { ok: boolean; ms: number };
}

async function timed(fn: () => Promise<unknown>): Promise<{ ok: boolean; ms: number }> {
  const t0 = Date.now();
  try {
    await fn();
    return { ok: true, ms: Date.now() - t0 };
  } catch {
    return { ok: false, ms: Date.now() - t0 };
  }
}

export async function runKeepWarm(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<WarmResult> {
  const sql = getDb(env);
  try {
    const [database, redis] = await Promise.all([
      timed(() => sql`select 1`),
      timed(() => upstash(env, "PING")),
    ]);
    return { database, redis };
  } finally {
    ctx.waitUntil(sql.end());
  }
}
