// Tells "the database is overloaded / unreachable" (retry shortly) apart from "our code has a bug" (500).
// During a signup storm the first kind is expected: the right answer is a fast 503 + Retry-After, which the frontend
// retries with jitter, not an opaque 500 that looks like a crash and pages someone.
const NODE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);
const PG_CODES = new Set([
  "53300", // too_many_connections
  "53400", // configuration_limit_exceeded
  "57P01", "57P02", "57P03", // admin_shutdown, crash_shutdown, cannot_connect_now
  "08000", "08001", "08003", "08004", "08006", // connection exceptions
  "40001", "40P01", // serialization_failure, deadlock_detected: safe to retry
]);
const POSTGRESJS_CODES = new Set(["CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "CONNECTION_CLOSED"]);
const MESSAGE_RE = /too many (clients|connections)|connection (terminated|closed|refused|timeout)|remaining connection slots|connect timeout|timeout exceeded when trying to connect|server closed the connection/i;

export function isDbUnavailable(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown[] } | null;
  if (!e || typeof e !== "object") return false;
  const code = typeof e.code === "string" ? e.code : "";
  if (NODE_CODES.has(code) || PG_CODES.has(code) || POSTGRESJS_CODES.has(code)) return true;
  if (e.errors?.some?.(isDbUnavailable)) return true; // AggregateError (dual-stack connect attempts)
  if (e.cause && e.cause !== err && isDbUnavailable(e.cause)) return true;
  return typeof e.message === "string" && MESSAGE_RE.test(e.message);
}

/** Retry-After seconds with jitter, so a thousand clients told to "retry in 3 s" don't all come back in the same millisecond. */
export function retryAfterSeconds(base = 3, jitter = 3, rnd: () => number = Math.random): number {
  return Math.max(1, Math.round(base + rnd() * jitter));
}
