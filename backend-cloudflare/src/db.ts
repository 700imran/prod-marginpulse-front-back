import postgres from "postgres";
import type { Env } from "./config";

// postgres.js turns DATE columns (OID 1082) into JS Date objects by default. Every pipeline in this app
// treats dates as plain "YYYY-MM-DD" strings (that is what the API returns and what the reconciliation
// engine does arithmetic on), so a Date object silently broke matching (`Date.parse(String(date) + "T00:00:00Z")`
// is NaN) and crashed `new Date(…)` math with "Invalid time value". Keep DATE as text, both directions.
const dateAsText = {
  to: 1082,
  from: [1082],
  serialize: (x: unknown) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x)),
  parse: (x: string) => x,
};

export function createSql(connectionString: string) {
  return postgres(connectionString, {
    max: 5,
    fetch_types: false, // skip an extra round trip on cold start; we don't use custom types
    idle_timeout: 5,
    connect_timeout: 10, // seconds: a dead/overloaded database answers 503 quickly instead of hanging the request until the platform kills it
    types: { date: dateAsText },
  });
}

// One `postgres.js` client per request is the documented Hyperdrive
// pattern for Workers (no persistent connections between requests are
// possible in an isolate anyway — Hyperdrive's pool lives at the edge,
// not in the Worker). Hyperdrive is doing the real pooling behind
// HYPERDRIVE.connectionString.
export function getDb(env: Env) {
  return createSql(env.HYPERDRIVE.connectionString);
}

export type Sql = ReturnType<typeof createSql>;
