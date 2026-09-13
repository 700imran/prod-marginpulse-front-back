import type { MiddlewareHandler } from "hono";
import type { Env } from "../config";
import { getDb, type Sql } from "../db";

// Opens exactly one Hyperdrive-backed Postgres connection per request,
// shared by requireAuth and every route handler via c.get("sql"), and
// closes it once the whole request is done. Register this before
// requireAuth in src/index.ts.
export const withDb: MiddlewareHandler<{ Bindings: Env; Variables: { sql: Sql } }> = async (c, next) => {
  const sql = getDb(c.env);
  c.set("sql", sql);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(sql.end());
  }
};
