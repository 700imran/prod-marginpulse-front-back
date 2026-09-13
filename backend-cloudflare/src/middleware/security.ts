import type { MiddlewareHandler } from "hono";
import type { Env } from "../config";

// Replaces middleware.go's RequestID + SecurityHeaders + CORS.

export const requestId: MiddlewareHandler = async (c, next) => {
  const id = crypto.randomUUID();
  c.set("requestId", id);
  await next();
  c.header("X-Request-Id", id);
};

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
};

export function corsMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const origin = c.env.FRONTEND_ORIGIN;
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    c.header("Access-Control-Allow-Headers", "Authorization,Content-Type");
    c.header("Access-Control-Allow-Credentials", "true");
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }
    await next();
  };
}
