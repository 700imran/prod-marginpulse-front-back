import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { errorBody, type ErrorCode } from "./errors";

// The one function every route should call to return an error, instead
// of building `c.json({ error: "..." }, status)` ad hoc — see
// src/errors.ts for why the shape looks like it does. Status is passed
// explicitly (not derived from `code`) so this refactor never changes an
// existing endpoint's HTTP status, only enriches the body.
export function apiError(c: Context, status: ContentfulStatusCode, code: ErrorCode, message: string, details?: Record<string, unknown>) {
  const requestId = (c.get("requestId") as string | undefined) ?? crypto.randomUUID();
  return c.json(errorBody(code, message, requestId, details), status);
}
