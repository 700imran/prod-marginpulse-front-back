import postgres from "postgres";
import type { Env } from "./config";

// One `postgres.js` client per request is the documented Hyperdrive
// pattern for Workers (no persistent connections between requests are
// possible in an isolate anyway — Hyperdrive's pool lives at the edge,
// not in the Worker). Keep max:5 and idle_timeout small; Hyperdrive is
// doing the real pooling behind HYPERDRIVE.connectionString.
export function getDb(env: Env) {
  return postgres(env.HYPERDRIVE.connectionString, {
    max: 5,
    fetch_types: false, // skip an extra round trip on cold start; we don't use custom types
    idle_timeout: 5,
  });
}

export type Sql = ReturnType<typeof getDb>;
