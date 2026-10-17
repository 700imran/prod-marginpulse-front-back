// usage_events is a record of every metered call *attempt* — including
// ones that were denied before any credit was spent. It exists for
// observability/analytics (see docs/OPERATIONS.md once someone builds a
// usage dashboard off it) and is deliberately separate from credit_ledger:
// credit_ledger is the money truth, usage_events is the "what happened"
// truth. Never derive a wallet balance from this table.
import type { Sql } from "../db";

export interface RecordUsageOptions {
  tenantId: string;
  provider: string; // 'GST_API' | 'BANK_VERIFY_API' | 'ANTHROPIC' | ...
  operation: string; // matches the operation key used in reserveCredits/pricing.ts
  outcome: "SUCCESS" | "FAILED" | "REFUNDED";
  creditsConsumed: number; // 0 for a denied/failed attempt, negative for a refund
  correlationId: string;
  jobId?: string;
}

export async function recordUsageEvent(sql: Sql, opts: RecordUsageOptions): Promise<void> {
  await sql`
    insert into usage_events (tenant_id, provider, operation, outcome, credits_consumed, correlation_id, job_id)
    values (${opts.tenantId}, ${opts.provider}, ${opts.operation}, ${opts.outcome}, ${opts.creditsConsumed}, ${opts.correlationId}, ${opts.jobId ?? null})
  `;
}

export interface UsageEventRow {
  usageEventId: string;
  provider: string;
  operation: string;
  outcome: string;
  creditsConsumed: number;
  correlationId: string;
  jobId: string | null;
  createdAt: string;
}

export async function listUsageEvents(sql: Sql, tenantId: string, limit = 100): Promise<UsageEventRow[]> {
  const rows = await sql<{ usageEventId: string; provider: string; operation: string; outcome: string; creditsConsumed: string; correlationId: string; jobId: string | null; createdAt: string }[]>`
    select usage_event_id as "usageEventId", provider, operation, outcome, credits_consumed as "creditsConsumed",
           correlation_id as "correlationId", job_id as "jobId", created_at as "createdAt"
    from usage_events where tenant_id = ${tenantId} order by created_at desc limit ${limit}
  `;
  return rows.map((r) => ({ ...r, creditsConsumed: parseFloat(r.creditsConsumed) }));
}
