import type { Env } from "../config";
import type { Sql } from "../db";
import { emit } from "../observability/events";

// Per-plan usage ceilings. Only FREE is capped: paid plans advertise "unlimited document extraction", and are
// protected by the rate limiters and the per-request size limits instead. The numbers are PLACEHOLDER business
// decisions — change them with wrangler vars (FREE_DOCS_PER_MONTH, FREE_BANK_ROWS_PER_MONTH; "0" = unlimited)
// without a redeploy of code. They exist so 5 lakh free signups cannot each store unlimited data on our bill.
export const DEFAULT_FREE_DOCS_PER_MONTH = 300;
export const DEFAULT_FREE_BANK_ROWS_PER_MONTH = 5000;

export interface PlanLimits { docsPerMonth: number | null; bankRowsPerMonth: number | null } // null = unlimited

function envLimit(v: string | undefined, dflt: number): number | null {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return dflt;
  return n === 0 ? null : Math.floor(n);
}

export function limitsFor(env: Pick<Env, "FREE_DOCS_PER_MONTH" | "FREE_BANK_ROWS_PER_MONTH">, planTier: string | null | undefined): PlanLimits {
  if (planTier && planTier !== "FREE") return { docsPerMonth: null, bankRowsPerMonth: null };
  return { docsPerMonth: envLimit(env.FREE_DOCS_PER_MONTH, DEFAULT_FREE_DOCS_PER_MONTH), bankRowsPerMonth: envLimit(env.FREE_BANK_ROWS_PER_MONTH, DEFAULT_FREE_BANK_ROWS_PER_MONTH) };
}

export interface PlanLimitBody { error: string; code: "PLAN_LIMIT"; resource: "documents" | "bank_rows"; limit: number; used: number; requested: number; upgrade: true }

/**
 * Returns null when the tenant may add `add`, otherwise the 402 body to send. Paid plans return null without touching
 * the database. A soft cap: two uploads racing at the boundary can both pass (by at most their own size), which is fine for
 * cost control and avoids a lock on the hot path.
 */
export async function checkQuota(sql: Sql, env: Pick<Env, "FREE_DOCS_PER_MONTH" | "FREE_BANK_ROWS_PER_MONTH">, tenantId: string, planTier: string | null | undefined, add: { docs?: number; bankRows?: number }): Promise<PlanLimitBody | null> {
  const lim = limitsFor(env, planTier);
  const wantDocs = Math.max(0, add.docs ?? 0), wantRows = Math.max(0, add.bankRows ?? 0);
  const needDocs = lim.docsPerMonth !== null && wantDocs > 0, needRows = lim.bankRowsPerMonth !== null && wantRows > 0;
  if (!needDocs && !needRows) return null;

  const [u] = await sql<{ docs: string; rows: string }[]>`
    select
      ${needDocs ? sql`(select count(*) from documents where tenant_id = ${tenantId} and created_at >= date_trunc('month', now()))` : sql`0`}::text as docs,
      ${needRows ? sql`(select count(*) from bank_transactions where tenant_id = ${tenantId} and created_at >= date_trunc('month', now()))` : sql`0`}::text as rows`;
  const docs = Number(u?.docs ?? 0), rows = Number(u?.rows ?? 0);

  if (needDocs && docs + wantDocs > lim.docsPerMonth!) {
    emit("quota", { resource: "documents", outcome: "blocked" });
    return { error: `The Free plan includes ${lim.docsPerMonth} documents per month and you have used ${docs}. Upgrade to add more, or wait until next month.`, code: "PLAN_LIMIT", resource: "documents", limit: lim.docsPerMonth!, used: docs, requested: wantDocs, upgrade: true };
  }
  if (needRows && rows + wantRows > lim.bankRowsPerMonth!) {
    emit("quota", { resource: "bank_rows", outcome: "blocked" });
    return { error: `The Free plan includes ${lim.bankRowsPerMonth} bank-statement rows per month and you have used ${rows}. Upgrade to import more, or wait until next month.`, code: "PLAN_LIMIT", resource: "bank_rows", limit: lim.bankRowsPerMonth!, used: rows, requested: wantRows, upgrade: true };
  }
  return null;
}

/** Same check when only the tenant id is known (WhatsApp / e-mail ingestion run without a logged-in tenant context). */
export async function checkQuotaForTenant(sql: Sql, env: Pick<Env, "FREE_DOCS_PER_MONTH" | "FREE_BANK_ROWS_PER_MONTH">, tenantId: string, add: { docs?: number; bankRows?: number }): Promise<PlanLimitBody | null> {
  const [t] = await sql<{ planTier: string }[]>`select plan_tier as "planTier" from tenants where tenant_id = ${tenantId}`;
  return checkQuota(sql, env, tenantId, t?.planTier ?? "FREE", add);
}
