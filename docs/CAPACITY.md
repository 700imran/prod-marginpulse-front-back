# Capacity: what happens at 500 → 5 lakh users

Short answer: **the code now degrades gracefully; the platform plans you are on decide the ceiling.** Code can refuse
excess work quickly, bound per-user storage and tell clients when to come back. It cannot create database connections,
Auth quota or Worker requests that your Cloudflare/Supabase plans do not include.

## What a user actually costs (the shape of the traffic)

* **Sign-in does not touch our Worker.** The browser signs in against Supabase Auth directly (`supabase.auth.signInWithPassword`). A
  500-user simultaneous login is a Supabase Auth load, not a Worker load. Turnstile (when enabled) stops bots before that call.
* **Opening the app ≈ 10 API calls** (dashboard fan-out), served from a per-tab cache afterwards.
* **OCR runs in the browser** (Tesseract), so invoice photos/PDFs cost the Worker no OCR CPU; the Worker stores the file and the extracted fields.
* **Heavy calls** are file upload, dataset import (CSV/XLSX rows → documents/bank rows → reconcile), reconcile-all and export. These hold a database connection the longest.

## Platform limits that bound the system (verified against the vendors' pages, Nov 2026)

| Resource | Free | Paid | Why it matters here |
|---|---|---|---|
| Workers requests / day | 100,000 | no limit | ≈ 10,000 app opens a day in total on Free. **Free cannot serve a large user base.** |
| Workers CPU / request | 10 ms | up to 5 min (default 30 s) | A dataset import normalises thousands of rows: on Free it will exceed 10 ms. **Heavy imports need Workers Paid.** |
| Hyperdrive origin connections | ~20 | ~100 | The real choke point for concurrent uploads/imports. |
| Supabase Auth MAU | 50,000 | 100,000 included, then $0.00325 / MAU | 5 lakh active users ≈ (500,000 − 100,000) × $0.00325 ≈ **$1,300 / month in MAU overage alone**. |
| Supabase database size | 500 MB | 8 GB then $0.125 / GB | See "Storage" below. |
| Supabase connections (Pro, Micro compute) | not published | 60 direct / 200 pooler | Move to a larger compute size as concurrency grows. |
| Supabase Free project | paused after 1 week idle | never paused | A paused project = every request is a `db_unavailable` 503. |

Sources: [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits), [Hyperdrive limits](https://developers.cloudflare.com/hyperdrive/platform/limits/), [Supabase pricing](https://supabase.com/pricing). Supabase does not publish Auth rate limits or per-plan connection limits for Free on that page — check *Auth → Rate Limits* and *Settings → Database* in your own project, and plan custom SMTP for sign-up e-mails (the built-in sender is meant for testing).

## What the code does about it

| Control | Where | Behaviour |
|---|---|---|
| **Load shedding** | `src/middleware/shed.ts`, applied to upload, dataset-upload, reconcile-run, export | Max `MAX_HEAVY_INFLIGHT` (default 8, `0` = off) concurrent per isolate. Excess gets an **instant `503 {code:"BUSY"}` + jittered `Retry-After`** before any auth/DB work, so cheap endpoints (dashboard, login-adjacent calls) keep working. |
| **DB overload → 503, not 500** | `src/lib/dbErrors.ts`, `app.onError` | Pool exhausted, connect timeout (10 s), shutdown/failover → `503 BUSY` + `Retry-After`; counted as `db_unavailable`. Real bugs still return 500. |
| **Free-plan quotas** | `src/billing/limits.ts` | FREE only: `FREE_DOCS_PER_MONTH` (default **300**), `FREE_BANK_ROWS_PER_MONTH` (default **5000**), `0` = unlimited. Over the cap → **`402 {code:"PLAN_LIMIT", resource, limit, used}`**; the whole file is refused, never half-imported. Applies to web upload, dataset import, WhatsApp and e-mail ingestion. Paid plans: no check, no query. |
| **Cron fan-out** | `src/index.ts` `scheduled()` | Daily missing-invoice detection is now **one queue message per tenant that has an old unmatched debit and a vendor on file**, keyset-paginated. Before: only the first 1000 tenants were ever checked, sequentially, in one invocation. |
| **Jittered client backoff** | `frontend/src/busyRetry.js` | Reads retry 503/429; uploads retry only `{code:"BUSY"}`; waits `Retry-After` + 0–50 % jitter, gives up after a bounded time and shows the server's message. |
| **Existing** | rate limiters, size limits, Turnstile, queue retry + DLQs | Unchanged. |

**The FREE limits are placeholders** — the product has no documented free allowance. Choose them deliberately (and tell users on the pricing page); change them with `wrangler.toml` vars, no code change.

### Soft edges (honest)

* The shed counter is **per isolate**. A surge spread over many isolates is bounded per isolate, not globally; the global brake is the Hyperdrive/Postgres connection limit, which now produces clean 503s instead of crashes.
* Quotas are **soft at the boundary**: two uploads racing at the cap can both pass (by at most their own size). That is intentional — no lock on the hot path.
* A refused (503) client retries; with thousands of clients that is a lot of cheap requests. They are cheap by design (the shed runs before auth/DB) but they still count against Workers' request quota.

## Storage (illustrative arithmetic — measure your own rows)

Each document/bank row is on the order of 1–2 KB including indexes. With 5 lakh users × ~50 rows ≈ 25 M rows ≈ 25–50 GB — far beyond the Free 500 MB and well into paid-disk territory. The Free quotas above bound the *worst case per user per month* (300 documents + 5,000 bank rows); without them one user can store unbounded data. Add a retention/archival policy before growth, not after.

## What was measured here

`test/capacity.test.ts` (real app + real Postgres, single laptop-class container — **not a production benchmark**):

* **Storm:** 120 tenants import at the same moment through a 15-slot shed. First try: 15 accepted, 105 refused in ~0 ms with `503 BUSY` + `Retry-After`; clients retried (≈2,000 cheap retries) and **all 120 finished**; every tenant ended with exactly its own rows (no loss, duplication or cross-tenant leak); no 500s; request latency p95 ≈ 160 ms, max < 1 s.
* **DB down:** pointing the app at a dead database returns 503 + `Retry-After` with no connection details in the body, and recovers the moment the database is back.
* **Quotas:** a Free tenant over the cap gets 402 and nothing is written; a paid tenant is unaffected.

## What was NOT tested

Real Supabase/Hyperdrive/Workers behaviour under load, Supabase Auth throughput, e-mail delivery limits, R2 throughput, and a multi-isolate surge. Before a launch or campaign: run a load test against a staging deployment on the **paid** plans you intend to use (k6/Artillery against `/api/v1/*` with the shed and quota settings you will ship), and watch `LoadSheddingActive`, `DatabaseUnavailable` and `FreePlanQuotaBlocking` in Grafana (see `observability/README.md`).

## Order of upgrades when traffic grows

1. Workers **Paid** (removes the 100k/day and 10 ms CPU ceilings) — required before any real launch.
2. Supabase **Pro** and a bigger compute size when `DatabaseUnavailable` appears; raise the Hyperdrive limit with it.
3. Only then raise `MAX_HEAVY_INFLIGHT`.
4. Review FREE quotas against actual storage cost; add retention for old documents.
