# Scalability checklist — MarginPulse checked against the "Measure → Optimise → Scale" list

Checked on 17 Nov 2026 against the checklist from the system-design reel (monolith first → database → read-heavy → scale out).
Every ✅ below has a test or a measurement behind it; "⚠️ decision" items need a choice from you; "❌" is a gap that is not fixed here.
For the capacity/load-shedding side see [`CAPACITY.md`](CAPACITY.md).

## Summary

| # | Checklist item | Status | One line |
|---|---|---|---|
| 1 | Start with a monolith, one deploy, managed Postgres | ✅ | One Worker + Supabase Postgres. No microservices. |
| 2 | Monitoring | ✅ / ❌ | Metrics, traces, 26 alert rules, Grafana, browser RUM. **No error-aggregation service (Sentry-style)**. |
| 3 | Verified backups | ⚠️ decision | New `scripts/verify-backup.sh` proves a dump restores and matches. Whether Supabase keeps backups depends on your plan — **check it**. |
| 4 | Indexes | ✅ fixed | 7 indexes added after `EXPLAIN` on 3.6 lakh rows; one 1,000× win, several 100×. |
| 5 | Remove N+1 queries | ✅ fixed / noted | GST sync: 30,000 updates → 4. Cron fan-out query 13× cheaper. One bounded loop left (below). |
| 6 | Cache hot reads (Redis + TTL) | ⚠️ decision | Deliberately no read cache. **Hyperdrive query caching is ON** and can serve data up to 75 s old after a write. |
| 7 | Static files → CDN | ✅ fixed | Served from Cloudflare's edge; hashed assets now `immutable` for a year. |
| 8 | Slow work → queue, retries, idempotency | ✅ fixed | 5 queues + DLQs + backoff already existed. Idempotency had **3 real bugs** (duplicate alerts, double-claimed bank row, undone match) — fixed, tested. |
| 9 | Read replicas / replication lag | n/a | No replicas. The same hazard exists through Hyperdrive caching (item 6). |
| 10 | Rate limiting | ✅ | Per-isolate + Upstash limiters, load shedding on heavy endpoints. |
| 11 | Timeouts on external APIs | ✅ | Every outbound call has a timeout (checked by grep, below). |
| 12 | Auto scaling / stateless servers | ✅ | Workers scale by themselves and hold no session state; the database is the ceiling. |
| 13 | "$0 stack" slide | info | Your stack already matches it except the AI provider and Supabase's free-tier limits. |

---

## 4. Indexes — what was measured

Method: a scratch database with 1,500 tenants (3 "whales" with 30,000 documents / 60,000 bank rows each; 1.8 lakh documents and
3.6 lakh bank rows overall), `ANALYZE`, then `EXPLAIN (ANALYZE, BUFFERS)` on every query the repositories run. Laptop-class
Postgres 16 — compare the *ratios*, not the absolute milliseconds. Fix is `backend-cloudflare/db/005_scale_indexes.sql`
(also in `schema.sql`; test: `test/scale-indexes.test.ts`).

| Query | Before | After | Why |
|---|---|---|---|
| Delete 60 documents (foreign-key checks) | **2,959 ms** | **2.7 ms** | 5 foreign keys had no index on the referencing column → one full-table scan per row per key |
| "Open anomaly for this bank row?" (once per bank row in missing-invoice detection) | 1.3 ms | 0.01 ms | `idx_anomalies_related_tx` |
| Duplicate-invoice check (per document processed), tenant with 30k documents | 7.3 ms (grows with the tenant) | 0.05 ms | `(tenant_id, vendor_name, invoice_number)` |
| Free-plan monthly quota count, tenant with 60k bank rows | 16.0 ms | 2.5 ms | `(tenant_id, created_at)` index-only scan of this month |
| Daily cron "which tenants have work", first page of 500 tenants | 116 ms, 222,000 buffers | 9 ms, 3,500 buffers | query rewritten to probe per tenant with `EXISTS` instead of one `EXISTS` per bank row; identical result set (verified row-for-row) |

Already fine (no change): document list (0.1 ms, even with `OFFSET 20000` 5 ms), bank list by status (0.05 ms), anomalies list, audit log
per entity, unmatched-in-range (0.4 ms), reconcile-run read (4 ms for 15,000 rows).

Cost of the new indexes: bulk-inserting 20,000 documents + 40,000 bank rows took the same time before and after (≈ 0.3 s + 0.5 s; run-to-run
noise is larger than any difference). The five foreign-key indexes are **partial** (`where col is not null`), so rows that are never
matched/duplicated add nothing.

Not changed, on purpose: `listBankTransactionsByTenant` (unfiltered list ordered by date) is the one plan that scans a whole tenant — but
nothing calls it, so no index was added for it. Add `(tenant_id, transaction_date desc)` if you ever build that screen.

**Applying it to production:** run `db/005_scale_indexes.sql` in the Supabase SQL editor. On a table that is already large, run each
statement separately with `create index concurrently` so writes are not blocked while it builds (instructions are in the file header).

Side finding: `audit_log` rows cannot be deleted (a trigger blocks it, by design), so deleting a *tenant* that has audit rows fails. If you
promise users "delete my data", that needs a deliberate, logged erasure path — not a plain `delete`.

## 5. N+1 queries

| Place | Finding | Action |
|---|---|---|
| `syncGSTPortal` (queue task) | One `UPDATE` per invoice, sequentially: 30,000 invoices = 30,000 round trips through the pool. A single failure was only logged and swallowed. | **Fixed**: one `UPDATE … WHERE id IN (…)` per resulting status (≤ 4), chunked at 5,000 ids, tenant-scoped. A failure now throws so the queue retries (the write is idempotent). Test: `setGstPortalStatuses…` in `scale-indexes.test.ts`. |
| Daily cron candidate query | One documents lookup per UNMATCHED bank row | **Fixed** (table above). |
| Missing-invoice detection (`pipelines/missingInvoice.ts`) | Per *flagged* bank row: one existence check + insert + audit entry | Left as is: only rows that look like an unpaid-invoice vendor payment are flagged, and the existence check is now an index lookup. If a first-ever run on a huge tenant flags thousands, batch the inserts like `tenantReconcile.ts` does. |
| Document correction route | ≤ 7 audit entries per request (one per changed field) | Fine. |
| Reconcile run, dataset import, export | Already chunked bulk statements / keyset pages | Fine. |

## 6. Caching

* **No Redis read cache — by design.** Upstash is used for rate limiting and webhook de-duplication only. Everything tenant-specific is
  read fresh. The browser keeps a per-tab cache; the public config endpoint is `Cache-Control: public, max-age=300`; the tenant row is
  cached 15 s per Worker isolate and dropped immediately when the same isolate writes it.
* ⚠️ **Hyperdrive query caching is enabled** on `marginpulse-db` (`caching.disabled = false`, defaults: `max_age` 60 s,
  `stale_while_revalidate` 15 s). Per Cloudflare's docs it caches plain `SELECT`s, **never invalidates them when you write**, and our driver
  uses prepared statements (the postgres.js default), which is the cacheable case. So a repeated identical read can return data up to
  **75 s old** after a write. Concrete risks here:
  * upload a document, open the list → the new row may be missing for up to a minute;
  * pay for a plan, then upload → the tenant/plan read can still say FREE, so the new quota check can answer `402 PLAN_LIMIT` to a customer who just paid;
  * the "was this payment already applied?" check reads the audit log — a cached "no" lets a repeated verification apply the upgrade twice (harmless in effect, noisy in the audit trail);
  * settings saved, page reloaded → old settings shown.
  Queries containing `now()` / `current_date` are not cached (e.g. the quota counts), which hides the problem in some places and not others.
  **Recommendation:** turn caching **off** on this Hyperdrive configuration (you keep pooling and fast connections; this is the setting Cloudflare
  recommends when most reads must be fresh). If database load later demands caching, add a *second* cache-enabled binding used only by
  public, staleness-tolerant reads. I did **not** change it — it is live infrastructure; say the word and it is one API call, reversible.

## 7. Static files / CDN

The frontend is served by Cloudflare (Workers static assets, `frontend/wrangler.jsonc`), so files already come from the nearest edge. Gap found:
no `Cache-Control` for the build's hashed files, so browsers re-validated them on every visit. `frontend/public/_headers` now marks
`/static/*` (content-hashed file names, safe to cache forever) `public, max-age=31536000, immutable`. `index.html` and the 23 MB of unhashed OCR
assets are intentionally left on revalidate-with-ETag so a new deploy is picked up at once.

## 8. Queues, retries, idempotency

Already in place: five queues, each with a dead-letter queue, exponential backoff (10 s → 15 min), "transient" vs "permanent" failure
classification, and metrics/alerts on retries and give-ups. Reviewed for idempotency (at-least-once delivery means any task can run twice;
documents of one tenant are also reconciled **concurrently**). Reproduced three real bugs first (tests failed on the old code), then fixed:

| Bug (reproduced by `test/idempotency.test.ts`) | Effect | Fix |
|---|---|---|
| A redelivered/re-run reconciliation created another RECONCILIATION_* alert every time (3 runs → 3 alerts) | Dashboard filled with copies | `createAnomalyOnce`: no new alert while an identical OPEN one exists |
| A retried OCR task recorded the DUPLICATE_INVOICE alert **and** its audit entry again | Duplicate alerts + noisy audit trail | Same helper; audit entry only when the alert is new |
| Two identical invoices (same vendor, amount, date — a recurring bill) reconciled at the same moment **both** became RECONCILED against the **same** bank row | Wrong books: one payment counted for two invoices | Bank row is *claimed atomically* (`UPDATE … WHERE status='UNMATCHED'`) before the document is marked; the loser looks again. Conflicts are counted as `reconcile_claim_conflict`. |
| A redelivered task after a successful match concluded "no candidate" (its own bank row was no longer *unmatched*) and could undo the match | Lost match | Candidates now include the bank row already matched to this document |

Not hard-guaranteed: two truly simultaneous identical alerts can still both insert (informational only; a unique index was avoided because
duplicates already in production would block creating it).

## 3. Backups — verified, not assumed

`backend-cloudflare/scripts/verify-backup.sh`: dumps schema `public` from the **direct** (non-pooler) connection, restores it into a throw-away
database on a scratch Postgres, compares the row count of every table, drops the scratch database, and exits non-zero on any mismatch.
Tested here against the 1,500-tenant database (18 tables, all counts equal, scratch DB removed) and against bad input (fails loudly).
Run it monthly, and after any big migration:

```bash
SOURCE_DB_URL='postgresql://…direct connection…' \
RESTORE_ADMIN_URL='postgresql://postgres:…@localhost:5432/postgres' \
  backend-cloudflare/scripts/verify-backup.sh
```

It tests that *a dump you take* is restorable. It does not test Supabase's own backups — confirm in Supabase → Database → Backups that your plan
keeps them (and for how many days / whether point-in-time recovery is on), and note the R2 bucket with uploaded invoices is **not** part of a database backup.

## 11. External API timeouts

`grep` over `src/` for outbound `fetch(` found no unbounded call: provider calls go through `fetchExternal` (default timeout, typed
`ExternalCallError`), and the direct ones carry their own — telemetry push 4 s, visitor identity lookup 4 s, Turnstile 5 s, Upstash 1.5 s, Razorpay (billing) 10 s via an
abort controller. Database connect timeout is 10 s (a dead database answers `503 BUSY` instead of hanging).

## 2. Monitoring — the one real gap

You have Prometheus/Grafana metrics, traces, alert rules and browser RUM (see `observability/README.md`). Missing versus the checklist: **a service that
groups exceptions** (Sentry-style: "this error happened 412 times since the 14:00 deploy, here is the stack"). Today unhandled errors become
a 500 with a request id plus a structured log line; you find them by searching logs. Sentry has a free tier; the Worker SDK is a small change.
Not added: it is a third-party service that would receive stack traces, so it is your call (and a privacy-policy line).

## 12. Auto scaling and stateless servers

Workers scale out automatically and keep no user session — every request carries a Supabase JWT. Per-isolate memory is used only for soft things
(rate-limit buckets, the heavy-endpoint shed counter, the 15 s tenant cache, JWKS cache); losing an isolate loses nothing. The real ceilings are
the database connection limit (Hyperdrive `origin_connection_limit` = 20 on this configuration) and Supabase/Workers plan limits — see `CAPACITY.md`.

## 13. The "$0 stack" slide vs. this project

Your stack already is that shape: GitHub → Cloudflare (Workers, Queues, R2, static assets) + Supabase Postgres. Differences: Postgres is Supabase, not D1
(correct choice here: relational reconciliation queries, RLS, Auth). The AI feature (insights) uses Anthropic with a daily budget guard; Gemini/Groq/Workers AI
free tiers could replace it but come with rate limits and different data-handling terms for customers' financial data — a product decision, not made here.
The slide's "free" numbers are for a hobby SaaS: the Workers Free limits that matter for you (10 ms CPU, 100k requests/day) are in `CAPACITY.md`.

## What to do next (in order)

1. Run `db/005_scale_indexes.sql` in Supabase (concurrently if the tables are already big).
2. Decide on Hyperdrive caching (recommendation: disable on this configuration).
3. Run `verify-backup.sh` once and confirm Supabase backups for your plan.
4. Decide on Sentry (or a similar error grouper).
5. Before a launch: the paid-plan load test described at the end of `CAPACITY.md`.
