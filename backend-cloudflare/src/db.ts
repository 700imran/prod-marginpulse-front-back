import postgres from "postgres";
import type { Env } from "./config";

// One `postgres.js` client per request is the documented Hyperdrive
// pattern for Workers (no persistent connections between requests are
// possible in an isolate anyway — Hyperdrive's pool lives at the edge,
// not in the Worker).
//
// max:1 — deliberately one physical connection, not a small pool.
// Row-Level Security (db/schema.sql) relies on a `SET app.tenant_id`
// issued once per request (middleware/auth.ts, queue/consumer.ts,
// routes/webhooks.ts) applying to every later query in that same
// request. That's only guaranteed if all of those queries run on the
// *same* physical connection — with max>1, a concurrent query could
// pick up an idle connection that never got the SET, silently losing
// tenant scoping. This app's handlers are sequential (await one query at
// a time), so there's no throughput loss from max:1 in practice; if that
// ever changes, wrap the tenant-setting query and everything after it in
// one sql.begin() transaction instead of raising max back up.
export function getDb(env: Env) {
  return postgres(env.HYPERDRIVE.connectionString, {
    max: 1,
    fetch_types: false, // skip an extra round trip on cold start; we don't use custom types
    idle_timeout: 5,
  });
}

export type Sql = ReturnType<typeof getDb>;
