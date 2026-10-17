// One JSON shape for every error response this API returns, whether it's
// an explicit `apiError(...)` call in a route handler or an exception
// the global handler in index.ts catches. The shape:
//
//   { "success": false, "error": { "code", "message", "requestId" } }
//
// `code` is a small, stable, machine-readable set (below) a frontend can
// switch on without parsing prose. `message` is safe to show a user —
// nothing here should ever put a stack trace, a raw Postgres error, an
// internal file path, or any other implementation detail into a message
// that reaches the client. `requestId` matches the `X-Request-Id`
// response header (src/middleware/security.ts) and whatever this same
// request logged server-side via console.error, so a support
// conversation ("I got an error") can be tied back to the exact log line
// without the client ever needing to see anything sensitive.
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INSUFFICIENT_CREDITS"
  | "RATE_LIMITED"
  | "NOT_IMPLEMENTED"
  | "UPSTREAM_ERROR"
  | "INTERNAL_ERROR";

export interface ApiErrorBody {
  success: false;
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export function errorBody(code: ErrorCode, message: string, requestId: string, details?: Record<string, unknown>): ApiErrorBody {
  return { success: false, error: { code, message, requestId, ...(details ? { details } : {}) } };
}

// Thrown from anywhere — a route, a pipeline, a repository — and caught
// by the global handler in index.ts. The preferred way to signal a
// specific, user-facing error from deep in a call stack without
// threading a Hono Context down into pipelines/repositories just to call
// c.json(). Anything that isn't an AppError is treated by the global
// handler as an unexpected internal failure — logged in full server-side,
// reported to the client as a generic INTERNAL_ERROR with no detail.
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: ContentfulStatusCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, status: ContentfulStatusCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
