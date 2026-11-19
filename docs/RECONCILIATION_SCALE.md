# Reconciliation: where it runs, and how far it scales

## Where it runs

| Trigger | Code | Runs in |
|---|---|---|
| "Run reconciliation" button, new bank/invoice upload | `routes/reconciliation.ts` → enqueues `reconcile_tenant` on `RECONCILE_QUEUE` (falls back to inline if the queue is down) | queue consumer (`queue/consumer.ts` → `reconcileTenantTask`) |
| Dataset upload (CSV/Excel import) | `routes/reconciliation.ts` (inline, one call) | the request Worker |
| One document just finished OCR | `queue/consumer.ts` `runReconciliation` (per document; atomic bank-row claim) | queue consumer |
| Daily "paid but no invoice" sweep | cron `scheduled()` → fan-out per tenant | queue consumer |

The whole-tenant pass is `pipelines/tenantReconcile.ts`: it loads every `PARSED` invoice and every `UNMATCHED` bank row for the tenant,
runs the matching engine in memory (`pipelines/reconciliation.ts`), then writes the results back with a handful of set-based
statements (`jsonb_to_recordset`, 1,500 rows per statement) — not one query per row.

## What the engine costs

The engine sorts bank debits by amount and binary-searches a window around each invoice, so ordinary data is near-linear.
The expensive part is one *candidate object per (invoice, bank row) pair* that passes the amount gate and the date window
(−7 / +45 days). That number grows with the **square** of how many invoices share an amount (rent, retainers, round bills).

Measured on this repo's benchmark (`node --expose-gc --max-old-space-size=128`, i.e. a Worker-sized heap):

| Dataset | Pairs | Time | Result |
|---|---|---|---|
| 20,000 invoices × 21,950 bank rows, ordinary mixed amounts | small | **2.3 s**, ~77 MB heap (inputs included) | 15,923 reconciled / 3,487 review / 590 unmatched |
| 2,500 identical-amount invoices in one payment window | 5.8 M | **3.3 s** (was 15.4 s before tokenising once per row) | all reconciled (invoice numbers in narrations) |
| 5,000 identical-amount invoices spread over 150 days | 7.8 M | **5.0 s**, 20 slices | with invoice numbers: all 5,000 reconciled · without: all 5,000 to review (by design — see below) |
| 5,000 identical-amount invoices all in one 52-day window | 23 M | **11.4 s**, 51 slices | 4,093 reconciled · 907 reported `FAILED` with a reason (CPU cap) |
| *before this change*: 5,000 identical, one pass | 12 M | 44 s, ~470 MB | would exceed a Worker's 128 MB → crash → queue retry → DLQ |

## What protects it now

1. **Memory budget** (`RECONCILE_MAX_PAIRS`, default 400,000). One candidate costs ~90 bytes with its indexes; 1.5 M pairs ran out of a 128 MB heap in
   testing, 500 k fit. When a tenant's pair count is over budget, invoices are cut into date-ordered slices that each fit.
2. **Slices cannot be more eager than a single pass.** Each slice sees *all* bank rows; afterwards an auto-match is kept only if its narration carries the
   invoice number, or no invoice from another slice is an equally good claimant for that bank row. Contested ones become *manual review* suggestions.
   A bank row is auto-matched to at most one invoice, and suggestions pointing at a row someone else owns are re-run. Property-tested
   (`test/reconciliation-scale.test.ts`): everything auto-matched in sliced mode is auto-matched to the same payment by the global pass.
3. **CPU budget** (`RECONCILE_MAX_TOTAL_PAIRS`, default 20,000,000 ≈ 12 s of a Worker's 30 s). Beyond it the remaining (latest-dated) invoices are
   returned as `FAILED` with the reason *"Too many look-alike invoices … upload in smaller date ranges"*, and the run logs `reconcile_capped` /
   emits `reconciliation_capped`. Visible and bounded, instead of a Worker killed mid-run.
4. Under budget the output is **identical** to the plain engine (differential-tested on 40 random datasets, 6,001 invoices). Slicing logs `reconcile_sliced`.

## Honest limits

* A tenant with roughly **> 20–25 k invoices *and* bank rows in a single run**, or **thousands of identical-amount invoices inside one payment window**, will hit the
  caps. Realistic CA-firm months are far below this.
* Identical invoices with no invoice number in the narration go to **review**, not auto-match, at any size — the engine does not guess.
* Workers **Free** (10 ms CPU) cannot run reconciliation at all; it needs the Workers Paid plan.
* `reconcileTenant` still loads the whole tenant's open invoices and unmatched bank rows into memory (without `ocr_raw_text`). That is fine to tens of thousands
  of rows; beyond ~50 k rows a streaming/windowed load would be the next step.
* Bank-row writes in the whole-tenant pass are not guarded with `reconciliation_status = 'UNMATCHED'`; a document-level reconcile finishing at the exact same
  moment could be overwritten. Rare; the per-document path uses an atomic claim.

## Tuning

`wrangler.toml` `[vars]`: `RECONCILE_MAX_PAIRS`, `RECONCILE_MAX_TOTAL_PAIRS`. Raise the CPU cap only together with Workers `limits.cpu_ms`.
