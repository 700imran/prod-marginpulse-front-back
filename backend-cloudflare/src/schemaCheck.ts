// Is the database the code is pointed at actually the database this version of
// the code expects? Deploying code that needs tables/columns production doesn't
// have yet fails as a scatter of 500s on unrelated routes; this turns it into
// one clear signal (see routes/health.ts, and the post-deploy smoke test that
// rolls the deploy back on it).
//
// Keep REQUIRED_* in step with db/schema.sql — a test parses the schema file and
// fails if anything listed here isn't defined there, and a Postgres-backed test
// proves a missing table/column is actually detected.
import type { Sql } from "./db";

export const REQUIRED_TABLES = [
  "tenants", "documents", "anomalies", "audit_log", "tax_identifiers", "bank_accounts", "team_members",
  "credit_wallets", "credit_ledger", "usage_events", // added by the hardening pass (billing)
  "payment_orders", // plan purchases
  "telemetry_events", "metrics_counters", "issues", "issue_notes", "issue_occurrences", // operations telemetry + issue tracker
] as const;

export const REQUIRED_COLUMNS: readonly (readonly [table: string, column: string])[] = [
  ["documents", "deleted_at"],              // soft delete / trash
  ["tenants", "deletion_requested_at"],     // account-deletion grace period
  ["tenants", "plan_expires_at"],           // paid plan validity
];

export interface SchemaStatus {
  ok: boolean;
  /** Names of missing tables/columns — for logs only; never put these in a public response. */
  missing: string[];
  /** Row-level security is switched on for the tables that hold tenant data. Reported separately: it matters for isolation but doesn't stop the app serving requests. */
  rlsEnabled: boolean;
}

// All identifiers below come from the constants above, never from input, so
// building the statement as text is safe; it is one round trip for everything.
export async function checkSchema(sql: Sql): Promise<SchemaStatus> {
  const tableExprs = REQUIRED_TABLES.map((t, i) => `to_regclass('public.${t}') is not null as t${i}`);
  const colExprs = REQUIRED_COLUMNS.map(([t, c], i) =>
    `coalesce((select true from pg_attribute where attrelid = to_regclass('public.${t}') and attname = '${c}' and not attisdropped), false) as c${i}`);
  const rlsExpr = `coalesce((select bool_and(relrowsecurity) from pg_class where oid in (to_regclass('public.documents'), to_regclass('public.tenants'))), false) as rls`;
  const rows = await sql.unsafe<Record<string, boolean>[]>(`select ${[...tableExprs, ...colExprs, rlsExpr].join(", ")}`);
  const r = rows[0] ?? {};
  const missing = [
    ...REQUIRED_TABLES.filter((_, i) => !r[`t${i}`]),
    ...REQUIRED_COLUMNS.filter((_, i) => !r[`c${i}`]).map(([t, c]) => `${t}.${c}`),
  ];
  return { ok: missing.length === 0, missing, rlsEnabled: r.rls === true };
}
