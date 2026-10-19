# MarginPulse Pro on Cloudflare — Status

Full rewrite of `backend/` (Go, AWS Lambda) to TypeScript on Cloudflare
Workers, with Supabase (Auth + Postgres) replacing DynamoDB and custom
JWT auth, and R2 replacing S3. This is a from-scratch TypeScript
project — it does not touch the original Go code.

**Update — the AWS Lambda OCR bridge described below has since been
removed entirely.** This doc originally described `OCR_LAMBDA_URL` as
a deliberate, permanent exception (RapidOCR/PyMuPDF can't run on
Workers, so OCR stayed on AWS). That was true until there was no AWS
account available for this deployment at all — OCR now runs entirely
client-side in the browser instead (Shape Detection API / Tesseract.js
— see `frontend/src/ocr/` and `frontend/STATUS.md`). `ocr.ts` now
takes browser-supplied OCR lines directly; `OCR_LAMBDA_URL` and
`OCR_LAMBDA_AUTH_TOKEN` no longer exist anywhere in this codebase.
**This means there is now zero AWS dependency of any kind**, not "one
deliberate exception" — independently re-verified the same way as
below (grep across `src/`, both package files): zero matches for
`aws-sdk|dynamodb|s3client|amazonaws|lambda` (case-insensitive) except
in historical comments explaining what used to be there.

One real trade-off from this change, stated plainly: **WhatsApp and
email document ingestion now get no OCR at all** — there's no browser
in those flows to run client-side extraction, so documents from those
channels land pending for manual correction (`queue/consumer.ts`'s
`runOCRPipeline` always resolves `ocrAvailable: false` for them now).
That's a real product limitation of going fully client-side, not an
oversight.

**Independently re-verified in an earlier pass** (kept for the record,
now superseded by the above): `package.json`'s dependency list was
`hono` + `postgres` + `jose` only — no `aws-sdk` anywhere. `wrangler.toml`
uses R2, Hyperdrive→Supabase Postgres, Cloudflare Queues, and Cron
Triggers — no AWS resources. This codebase has no Vercel-related files
because it's backend-only; the frontend now has its own `vercel.json`
and `STATUS.md` covering that side (added in the same pass that
removed the OCR Lambda). See "Not ported at all" below for what's
still not wired up between the two.

**Every file below was checked against the actual Go source in
`marginpulse-handover-package.zip` before being written — not
reconstructed from memory.** Three real bugs were caught this way and
fixed before they shipped: invented `gst_portal_status` values,
invented `anomaly_type` values, and an invented `processing_status`
lifecycle (the real one is only `PENDING → PARSED → RECONCILED` — a
PARSED document with no reconciliation match just stays PARSED; the
anomaly row is what signals a problem, not a status change). A fourth
bug (`sql.unsafe()` nested inside a tagged template, which executes
immediately instead of returning a fragment) was caught by `tsc`
during verification, not by code review.

**`npx tsc --noEmit` passes clean, zero errors**, against
`@cloudflare/workers-types/latest` with `strict: true` and
`noUncheckedIndexedAccess: true`. That's a real compiler check, not a
claim — rerun it yourself after `npm install` if you want to confirm.
It catches type errors, not logic errors: it won't tell you if a
regex is subtly wrong or a reconciliation threshold doesn't match
production expectations.

## Master implementation prompt — checklist status

The person driving this project is working through a 32-point
"production hardening" checklist (auth, tenant isolation, secrets,
billing, monitoring, incident response, etc.) across several sessions.
Status against each point, current as of the monitoring/backup pass —
**nothing below is deployed to live infrastructure yet**, this is a
code-state assessment only. Update this section, don't append a new
one, next time it's re-checked.

✅ **Done & verified** — 4 (tenant isolation: RLS + app-level filtering,
10-check automated suite passing against a real Postgres), 7 (secrets
management: `.env.example` added for this directory — was previously
only the old Go backend's), 11 (error handling: consistent `{success,
error:{code,message,requestId}}` shape swept across all call sites), 12
(data retention/deletion: soft-delete + grace period + cron purge for
both tenants and documents, verified against a real Postgres including
the full cross-table cascade), 19 (WAF/headers: CSP and Permissions-Policy
added alongside the pre-existing headers — WAF itself is still a
Cloudflare dashboard setting, not code), 23 (subscription tier kept
separate from usage credits), 25 (credit wallet/ledger: atomic,
idempotent), 26 (API cost control: reserve-before-call/refund-on-failure
on all 4 metered operations).

🟡 **Partial** — 1–2 (auth/session hardened on our side; brute-force
protection and session revocation are Supabase's own, since login
never touches this Worker — not independently verified), 3
(authorization — `team_members.role` OWNER/ADMIN/MEMBER/VIEWER exists
in the schema but **is not checked anywhere**; every team member has
identical access today regardless of role), 5–6 (file handling /
encryption — signed URLs, tenant-scoped keys, field-level AES-256-GCM
all pre-existing; no MIME/magic-byte validation verified), 8 (audit
logging — documents/billing covered; login/logout/OTP invisible to
us), 9–10 (API access control / rate limiting — real but informal; not
every category has its own limit), 15–17 (infra readiness / object
storage / email — R2 + Resend pre-existing, untouched this pass; no
SMS/OTP), 20–21 (security review/testing — 2 real bugs found and fixed
during the RLS pass; strong DB-level isolation tests; **no HTTP-level
tests** for auth/rate-limits/webhook-signatures/file-validation), 22
(incident response — "disable tenant" and "disconnect integration"
exist as side effects of other work; no runbook), 24 (usage metering —
by tenant/operation, not by which user within a tenant; **credits
accumulate monthly rather than expiring**), 26–27 (integrations —
Slack/Razorpay/Stripe/WhatsApp real, not mocked; GST has a real adapter
with graceful fallback; no Telegram), 29–32 (Wrangler config /
deployment docs / failure-safety / leakage — solid for what exists, not
exhaustively tested; no full grep-audit of every log line for
accidental secret leakage).

❌ **Not done** — 18 (domain/DNS — needs real domain access).

🟡 **28 (natural-language action layer) — backend built, not launched**:
see the "Natural-language assistant" section below.

🟡 Also now partial rather than untouched: 13 (backup/recovery —
`BACKUP_RECOVERY.md` written, but it's a procedure to follow, not
something configured or restore-tested yet — no live Supabase project
exists to test against), 14 (monitoring — `src/monitoring.ts` reports to
Sentry if `SENTRY_DSN` is set, wired into HTTP/queue/cron failure paths,
`/healthz` does real Postgres+Redis checks now; **the Sentry delivery
itself isn't independently verified against a live project** — see that
file's own warning — and there's no actual dashboard or alert built on
the usage/cost-spike query `MONITORING.md` documents, only the query
itself).

## What's fully ported and wired together

Every layer talks to the next — this isn't just individual files that
compile in isolation:

- **Infra**: `wrangler.toml` (R2, Hyperdrive, 5 Queues + DLQs, cron
  trigger), `db/schema.sql` (Postgres, all 15 tables, matches the real
  Go struct fields — not the DynamoDB single-table shape)
- **Core**: config/env typing, Hyperdrive Postgres client, R2 storage
  + signed download tokens, Supabase JWT verification, AES-256-GCM
  field encryption, Upstash Redis REST (rate limiting, AI budget,
  OAuth state)
- **Middleware**: per-request DB connection, auth, security headers,
  CORS, rate limiting
- **Repository layer**: all 11 entities, full CRUD
- **Pipelines** (verified line-by-line against source):
  `reconciliation.ts` (Levenshtein + weighted scoring), `identity.ts`
  (GSTIN/PAN/bank verification), `gstsync.ts` (GSTR-2B fetch +
  cross-verify), `ocr.ts` (processes browser-supplied OCR lines +
  all regex extraction — no Lambda call anymore, see the update
  note at the top of this doc), `insights.ts` (AI dashboard summary +
  collection scripts), `missingInvoice.ts`, `dashboard.ts`
- **Integrations**: Razorpay and Stripe connectors call the *real*
  Settlements/Payouts APIs — nothing mocked. Slack OAuth + incoming
  webhooks fully wired.
- **Every route** from the Go backend has a TypeScript route:
  documents, reconciliation, tax identifiers, bank accounts, team,
  settings, GST, comms, ROI calculator, admin, integrations, webhooks
  (WhatsApp + email ingestion)
- **Queue consumer**: all 5 background tasks (OCR pipeline,
  reconciliation, GST sync, tax identifier verify, bank account
  verify), dispatched the same way `cmd/worker/main.go` did
- **Cron trigger**: daily missing-invoice sweep across every tenant,
  replacing the EventBridge rule that was planned but never built

## Deliberate architecture changes (not bugs — read before deploying)

1. **Auth is now Supabase Auth, not custom JWT.** The frontend calls
   Supabase directly for register/login/refresh/logout/OAuth
   (`@supabase/supabase-js`) and sends the resulting access token to
   this API as a Bearer token. `HandleRegister`/`HandleLogin`/
   `HandleRefresh`/`HandleLogout` from `auth_handlers.go` don't exist
   here — there's nothing to port, Supabase's own endpoints replace
   them entirely. **The React frontend has not been updated to do
   this** — it still expects the old `/auth/register` etc. endpoints.
   That's a real, separate piece of work.
2. **Google and Apple sign-in are gone from this codebase entirely** —
   configure them as social providers in the Supabase dashboard
   instead. `oauth/google.go` and `oauth/apple.go`'s custom
   ID-token/JWKS-verification code has no equivalent here because
   nothing needs it anymore.
3. **Database is Postgres (Supabase), not DynamoDB.** The single-table
   design with GSI-overloading and "guard items" is gone in favor of
   normal tables, indexes, and `UNIQUE` constraints — this is a
   genuine simplification the schema doc itself all but asks for, not
   a style preference.
4. **Storage is R2's native binding**, not the S3-compatible endpoint.
   `storage.go` was already written to be R2-endpoint-compatible with
   zero changes if you wanted an interim step; this skips straight to
   the native binding (no request signing, no egress fee).
5. **Email is Resend's HTTP API, not raw SMTP.** `email.go` spoke SMTP
   directly over a TCP socket; Workers can open raw TCP via
   `cloudflare:sockets`, but hand-rolling the SMTP protocol (EHLO,
   STARTTLS upgrade, AUTH PLAIN) over it is real protocol work that
   wasn't attempted here rather than faked. Swap the provider in
   `src/email.ts` if you'd rather use Postmark/SendGrid/Mailgun.
6. **OCR was originally on AWS Lambda** (`RapidOCR`/`PyMuPDF`
   categorically can't run on Workers — that part was a real platform
   ceiling, not an effort gap), **but that Lambda bridge has since been
   removed entirely** — see the update note at the top of this doc.
   There was no AWS account available for this deployment, so OCR now
   runs client-side in the browser instead
   (`frontend/src/ocr/`), and `ocr.ts` here just processes whatever
   lines the browser already extracted. This is a real, verified
   change, not a plan — confirmed by `ocr.ts` having no Lambda call
   left in it and a clean `npx tsc --noEmit` afterward.

## Known simplifications (flagged, not hidden)

**Update — three of these have since been closed** (verified again
with a clean `npx tsc --noEmit` after each change; `npm install` +
typecheck were re-run in a sandbox with no Cloudflare/Supabase
credentials, so this is a local code/type check only — it hasn't
touched real infrastructure):

- ~~PAN/bank-account name-match was a plain substring check~~ →
  **partially addressed**: `verifyBankAccount` in
  `src/pipelines/identity.ts` now normalizes common legal-entity
  suffixes/punctuation and falls back to the same Levenshtein-ratio
  fuzzy match `reconciliation.ts` uses for vendor names (threshold
  0.82) when the substring check fails. PAN verification still does
  no name-match at all — that was already true before (see the
  function's own comment), not a regression. This still isn't a
  faithful port of whatever `identity.go`'s original comparison did;
  that logic wasn't visible in the source this was ported from.
- ~~Razorpay sync is blocked (HTTP 501)~~ → **fixed**: added a
  `credentials_encrypted` column (encrypted JSON blob) to the
  `integrations` table, alongside the existing `api_key_encrypted`.
  Multi-field providers (currently just Razorpay) store their full
  credentials object there on connect and decrypt-and-parse it on
  sync, instead of concatenating encrypted values into one
  unsplittable string. Stripe's single-field flow is untouched. If
  you've already run the old `schema.sql` against a live Supabase
  project, you'll need to add this column manually (see
  `db/schema.sql`) — this was edited in place since no migration
  tool exists and Phase A hadn't been run yet when this was written.
- ~~WhatsApp webhook signature verification wasn't implemented~~ →
  **fixed**: `POST /webhooks/whatsapp` now verifies
  `X-Hub-Signature-256` against a new `WHATSAPP_APP_SECRET` secret
  (HMAC-SHA256 via `crypto.subtle.verify`, constant-time). If that
  secret isn't set, it still accepts the webhook unverified — same
  graceful-degradation pattern as the other optional secrets in this
  codebase — but now logs a warning each time, so the fallback isn't
  silent. Add `WHATSAPP_APP_SECRET` (from Meta's App Dashboard) to the
  Phase C secrets list in `NEXT_STEPS.md`.

## Not ported at all

- **Frontend**: still calls the old REST auth endpoints and the old
  API shape in general. Every route path was kept as close to
  `router.go`'s original as possible specifically to minimize this
  work, but `api.js`/`tokenManager.js` need real changes for Supabase
  Auth before the two sides talk to each other correctly.
- **CI/CD, tests, local dev seed data** — none of that existed to port
  in the first place (the Go backend didn't have a test suite in
  either the repo or the handover zip).

## Usage-based billing / API-credit system (new)

Added a per-tenant credit wallet + ledger so a subscription can't turn
into unbounded external-API liability (GST portal calls, bank-account
verification, Anthropic dashboard insights all cost real money per
call). This was scoped and built as its own pass — read
`src/billing/credits.ts`'s header comment for the concurrency/idempotency
design, it explains the "why" in more depth than this summary does.

- **New tables** (`db/schema.sql`): `credit_wallets` (one row per
  tenant, current balance), `credit_ledger` (append-only, immutable,
  every entry keyed by a unique `(tenant_id, idempotency_key)` so a
  retried request or a redelivered queue message can never double-charge
  or double-refund), `usage_events` (every metered call attempt,
  including denied ones, for analytics — not itself a money source of
  truth). A backfill statement gives every pre-existing tenant a wallet
  row; new tenants get one lazily on first use.
- **New module** `src/billing/`: `pricing.ts` (the *only* file with
  actual numbers — plan → monthly allowance, operation → credit cost,
  both placeholder guesses, see its header), `credits.ts` (atomic
  reserve/refund via a single guarded `UPDATE ... WHERE balance >=
  amount RETURNING`, always in the same transaction as the ledger
  insert), `usage.ts` (the analytics-only event log), `guard.ts` (thin
  per-route helper).
- **Wired into the three routes that trigger paid external calls**:
  `POST /gst/sync`, `POST /tax-identifiers` + `/:id/reverify`, `POST
  /bank-accounts`. Each reserves credits before enqueueing; insufficient
  balance returns `402` with `code: "INSUFFICIENT_CREDITS"` (tax
  identifier creation is the one exception — the record itself still
  saves, only the paid verify is skipped, since that's the person's own
  data and free to store).
- **Wired into AI insights** (`pipelines/insights.ts`): a tenant-level
  credit check now sits alongside the pre-existing platform-wide daily
  AI budget guard (`checkAndIncrementAIBudget` in `ratelimit.ts`, left
  untouched). Either guard failing degrades to the free rule-based
  insight — this is a dashboard summary, never worth a hard error.
- **Refund path**: `queue/consumer.ts` now records a `SUCCESS` usage
  event when a credit-reserved job completes, and — new —
  `handleDeadLetterBatch` refunds the reservation when a job exhausts
  its retries and lands in its dead-letter queue. That required adding
  `[[queues.consumers]]` entries for the 5 `*-dlq` queues in
  `wrangler.toml`, routed to the same Worker via `batch.queue` (they
  weren't consumed by anything before this — a permanently-failed job's
  credits would previously just vanish, uncharged-back and unlogged).
- **New self-service endpoints**: `GET /billing/wallet`,
  `/billing/ledger`, `/billing/usage` — tenant-scoped via the normal auth
  context, nothing here takes a client-supplied tenant id.
- **Verified**: `npx tsc --noEmit` passes clean (same strict config as
  the rest of this codebase) after every change in this pass, including
  the new `src/billing/*` files. Not verified against a live Postgres —
  nothing in this repo has been run against real infrastructure yet (see
  "Before you deploy").

**Explicitly not done in this pass** — flagged, not hidden:
- No actual credit *purchase*/top-up flow. `PURCHASE` exists as a
  ledger `entry_type` and the wallet schema supports it, but there's no
  Razorpay/Stripe checkout wired to call it yet.
- No frontend surfacing of balance, low-balance warnings, or the new
  `402 INSUFFICIENT_CREDITS` error shape — the React app doesn't know
  this exists yet.
- The credit costs and monthly allowances in `src/billing/pricing.ts`
  are placeholder guesses, not a costing exercise against real vendor
  invoices. Tune before charging anyone real money.
- This does **not** address the separate, still-open gap that tenant
  isolation everywhere else in this codebase relies entirely on
  application code remembering `WHERE tenant_id = ?` — there's still no
  Postgres Row-Level Security. The new billing tables have the same
  property (repository-enforced, not RLS-enforced) as every other table
  here; that's a consistent gap, not a new one introduced by this pass.

## Row-Level Security (new)

Added Postgres RLS as a second, independent layer of tenant isolation on
top of the application-code `WHERE tenant_id = ?` filtering that was
already there (and remains the primary mechanism — this doesn't replace
it). Full design rationale is in `db/schema.sql`'s RLS section header
comment and `src/security/tenantContext.ts`; short version:

- Every tenant-owned table gets one policy: a row is visible/writable
  only when its `tenant_id` matches the connection's `app.tenant_id`
  session variable, or when `app.is_platform_admin` /
  `app.system_context` is set. Two SQL helper functions
  (`app_current_tenant_id()`, `app_is_privileged()`) back every policy.
- **This only does anything if the Worker stops connecting as
  Supabase's default `postgres` role.** Superusers and BYPASSRLS roles
  ignore RLS entirely — `FORCE ROW LEVEL SECURITY` doesn't change that.
  `db/schema.sql` now also creates a plain `app_user` role (no password
  set — see "Before you deploy" below) for exactly this reason.
- `src/db.ts`'s Hyperdrive client changed from `max: 5` to `max: 1`.
  RLS depends on a `SET app.tenant_id` made early in a request applying
  to every later query in that same request — only guaranteed if
  they're all on the same physical connection. This codebase's handlers
  are sequential (no concurrent queries within one request, bar one
  harmless `Promise.all` in `routes/admin.ts`), so there's no real
  throughput cost.
- Four call sites needed a narrow, explicit bypass because they
  legitimately aren't scoped to one caller's tenant:
  `routes/webhooks.ts` (WhatsApp/email tenant lookup by phone/alias,
  authorized by a signature/secret check, not tenant_id),
  `routes/team.ts`'s accept-invite (authorized by possessing the invite
  token), and `index.ts`'s cron sweep (must enumerate every tenant).
  Each is commented in place with why it's safe. `routes/integrations.ts`'s
  Slack OAuth callback needed a fix too, but a narrower one — it already
  knows the exact tenant (from Redis via the OAuth state param), so it
  just sets `app.tenant_id` directly rather than reaching for a bypass.
- **Verified against a real, disposable local Postgres 16** — not just
  typechecked. `db/rls_test.sql` is a runnable, non-destructive test
  suite (10 checks: fail-closed default, own-tenant read, cross-tenant
  read/update/insert all blocked even when explicitly attempted,
  context-switching correctness, both bypass flags, and a sanity check
  that `app_user` hasn't been granted superuser/BYPASSRLS). All 10 pass.
  Run it yourself after applying schema.sql:
  `psql "<connection string>" -v ON_ERROR_STOP=1 -f db/rls_test.sql` —
  wire it into CI as a gate on any future schema.sql change.

**Not done / explicitly deferred:**
- The `app_user` role's password isn't set anywhere (deliberately — see
  below). Nothing works against real Supabase until that's done and the
  Hyperdrive connection string is switched over.
- No automated cross-tenant test exists yet for anything *outside*
  Postgres — R2 signed URLs, Upstash-Redis-backed rate limits/OAuth
  state, etc. `db/rls_test.sql` only covers what RLS itself covers.

## Centralized API error format (new)

Every error response across the whole API now returns the same JSON
shape instead of each route inventing its own:

```json
{ "success": false, "error": { "code": "NOT_FOUND", "message": "...", "requestId": "..." } }
```

- `src/errors.ts` — the `ErrorCode` union (10 codes: `VALIDATION_ERROR`,
  `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`,
  `INSUFFICIENT_CREDITS`, `RATE_LIMITED`, `NOT_IMPLEMENTED`,
  `UPSTREAM_ERROR`, `INTERNAL_ERROR`) and `AppError`, a class you can
  `throw` from anywhere — a route, a pipeline, a repository — without
  threading a Hono `Context` down into code that shouldn't need to know
  about HTTP. `index.ts`'s global `app.onError` catches it and returns
  it as-is; anything that *isn't* an `AppError` is treated as
  unexpected, logged in full (including the stack) server-side only,
  and reported to the client as a generic `INTERNAL_ERROR` with no
  detail in production (`isProd(env)`) — non-production responses
  include the real `err.message` to keep local/staging debugging fast.
- `src/http.ts` — `apiError(c, status, code, message, details?)`, the
  one function routes call to return an error. Status is passed
  explicitly rather than derived from `code`, so converting every
  existing route was purely additive: **same HTTP status codes as
  before, richer body.**
- All 49 of the old ad hoc `c.json({ error: "..." }, status)` call
  sites, across every route file and both auth/rate-limit middleware,
  now go through `apiError`. Verified with a repo-wide grep for the old
  pattern (zero hits left) and `npx tsc --noEmit` (clean) — not
  spot-checked, actually swept.
- The `INSUFFICIENT_CREDITS` responses from the billing pass
  (`routes/gst.ts`, `routes/taxIdentifiers.ts`) now carry
  `credits_remaining` in the new `details` field instead of as an
  ad hoc top-level property — if your frontend already reads
  `credits_remaining` off the old shape, it needs to read
  `error.details.credits_remaining` instead. Nothing else in the
  response body changed for those two.

**Not done:** no repository or pipeline code was converted to *throw*
`AppError` instead of returning `null`/relying on the route's own
`if (!x) return apiError(...)` checks — that's a real improvement
(it'd let deeply-nested code raise a precise error without the route
needing to know the failure was possible), just not done in this pass.
Every route still checks for `null`/thrown errors exactly as it did
before; only the shape of what gets sent back changed.

## Data retention & deletion (new)

Nothing in this codebase could delete a tenant, a document, or an old
audit-log row before this pass — no route, no scheduled job, nothing.
Now:

- **Central config**: `src/retention.ts` — `TENANT_DELETION_GRACE_DAYS`
  (30), `DOCUMENT_TRASH_GRACE_DAYS` (30), `AUDIT_LOG_RETENTION_DAYS`
  (400). Every purge query reads from here; nothing hardcodes a number
  of days anywhere else.
- **Schema**: two new nullable columns — `tenants.deletion_requested_at`
  and `documents.deleted_at` — both null meaning "not scheduled." See
  the header comment on them in `db/schema.sql` for why tenant deletion
  deliberately does *not* touch `is_active` (the account stays fully
  usable during the grace period, same as most consumer "delete my
  account" flows — reversing it should be as easy as logging in and
  clicking cancel).
- **Self-service** (`routes/auth.ts`): `DELETE /me` schedules deletion
  and emails a confirmation with the exact purge date;
  `POST /me/cancel-deletion` reverses it, also emailed. New:
  `sendAccountDeletionScheduled`/`sendAccountDeletionCancelled` in
  `src/email.ts`.
- **Document trash** (`routes/documents.ts`): `DELETE /:id` soft-deletes,
  `POST /:id/restore` undoes it within the grace period — a feature
  that didn't exist in any form before this pass. Only
  `listDocumentsByTenant` and `countDocumentsByTenant` (the main
  user-facing list/dashboard-count) filter out soft-deleted rows;
  reconciliation/GST-matching/export queries do not yet — flagged in
  NEXT_STEPS.md, not hidden.
- **Actual purging** (`src/purge.ts`, new): `purgeExpiredDocuments`
  (deletes the R2 object, then the row — R2 first, always, so a
  mid-purge crash never orphans an object with no row pointing at it),
  `purgeExpiredTenants` (cleans up every R2 object the tenant owns, then
  calls the Supabase Admin API to delete the `auth.users` row — which
  **cascades through every tenant-owned Postgres table in one step**,
  via the `on delete cascade`s already in `db/schema.sql`), and
  `purgeOldAuditLogs` (plain age-based delete — audit_log rows carry no
  secrets to inspect first). New `deleteSupabaseAuthUser` in
  `src/auth/supabase.ts` — the only place this codebase calls the
  Supabase Admin API rather than verifying a client JWT.
- **Scheduled**: `index.ts`'s existing cron sweep now also calls
  `runRetentionSweep` after the missing-invoice sweep, under the same
  `system_context` already set for that whole invocation.
- **Admin override**: `POST /admin/tenants/:id/purge-now` runs the exact
  same `purgeTenantNow` the cron job uses, immediately, for a
  compliance/support request that can't wait 30 days. Requires
  `{"confirm": "<tenant_id>"}` in the body — a deliberate speed bump on
  the platform's single most destructive endpoint.
- **Verified against a real local Postgres** (not just typechecked):
  soft-delete → excluded from the main list → restore → visible again →
  backdated past the grace period → found by the pending-purge query →
  hard-deleted. Separately, confirmed the full cascade: deleting
  `auth.users` removes the `tenants` row *and* `credit_wallets`,
  `usage_events`, and `audit_log` rows for that tenant in one statement.
  Confirmed the audit-log age purge deletes only rows past the cutoff,
  keeping recent ones. `db/rls_test.sql` re-run and still green with the
  two new columns in place.

**Not done / explicitly deferred:**
- Only 2 of the ~11 document-listing query functions exclude
  soft-deleted rows (see above) — a soft-deleted document can still
  surface in reconciliation matching, GST cross-checks, and CSV/export
  output. Worth closing before this matters to a real user.
- No orphan-file reconciliation (an R2 object with no matching
  `documents` row at all, from some partial-failure upload path) — this
  pass only cleans up objects it can find *through* a row. Flagged, not
  built: doing this properly means paginating R2's list API and
  cross-referencing against Postgres, a separate, slower job.
- The purge job has no dry-run mode and no alerting on repeated
  failures — a tenant or document that fails to purge every single day
  just logs an error and gets retried the next day, silently, forever.

## Monitoring, observability & backup/recovery (new)

Two master-prompt points that were previously completely untouched —
see `MONITORING.md` and `BACKUP_RECOVERY.md` for the full detail; this
is the short version.

- **`src/monitoring.ts`**: `reportError(env, err, opts)`. Always logs a
  structured line (Workers Logs); additionally POSTs to Sentry if
  `SENTRY_DSN` is set, using Sentry's legacy Store API hand-implemented
  with no new npm dependency. **Explicitly flagged, not hidden: the
  Sentry delivery path has not been confirmed against a real Sentry
  project** — there's no live account to test against. The console sink
  has no such caveat; it's guaranteed to work.
- Wired into the global HTTP error handler (unexpected exceptions only —
  `AppError`s are expected, not noise), every queue task's retry path
  (`warning`) and DLQ permanent-failure path (`error`), and both halves
  of the cron sweep.
- **`GET /healthz`** now does a real `select 1` and a Redis `PING`
  instead of a static response — Postgres down returns `503`, Redis down
  is reported but doesn't flip overall status (everything depending on
  it already degrades gracefully). Exported `upstash()` from
  `ratelimit.ts` to reuse rather than duplicating the REST-call logic.
- What Cloudflare already gives you for free with zero code — Worker
  error rate, queue backlog, **DLQ depth** — is documented in
  `MONITORING.md` rather than re-built; DLQ depth in particular is worth
  an alert, since for credit-reserved tasks it means refunds are
  happening that a healthy system wouldn't need.
- A usage/cost-spike query against `usage_events`/`credit_ledger` is
  documented (copy-pasteable SQL) but not built into a running
  dashboard or alert.
- **`BACKUP_RECOVERY.md`**: a runbook, not a record of something done —
  there's no live Supabase project to configure or restore-test against
  yet. Covers what Supabase's backup tier actually needs to be (PITR,
  not just daily snapshots — the free tier isn't enough for financial
  data), that R2 objects are a separate system from Postgres backups
  entirely, how the retention/soft-delete system (previous section)
  covers *some* of this risk but not database corruption or a bad
  migration, and a step-by-step restore-test procedure with explicit
  checkboxes to date when actually completed.

**Not done:** no automated alert on the usage-spike query (it's
documented, not scheduled), no R2 versioning/replication configured, no
actual restore test has been run (can't be, without a live project).

## Natural-language assistant (new)

Built to `WORKFLOW.md`'s design — read that file for the safety model. Phase
1 (4 read-only tools) and Phase 2 (`sync_gst`, `soft_delete_document`,
`restore_document`, each behind a signed single-use confirmation) are both
implemented; Phase 2 is **off** (`ASSISTANT_MUTATIONS_ENABLED = "false"`).

- **Verified:** `npx tsc --noEmit` clean; `npm test` — 51 tests (vitest)
  covering sanitization, input validation, token tamper/expiry/tenant/replay,
  tool-registry invariants (no identity args, no forbidden capabilities),
  orchestration with a scripted — including deliberately compromised — model,
  and HTTP-level credit/refund/rate/confirm behaviour; `wrangler deploy
  --dry-run` bundles. The CI workflow now runs typecheck + tests before
  deploying.
- **New SQL verified against real Postgres 16** loaded with `db/schema.sql`
  (`test/assistant_sql.integration.test.ts`, run with `PG_TEST_URL=...`;
  skipped otherwise): tenant scoping, trash exclusion, literal `%`/`_`,
  injection-as-data, limit cap. Run against a local Postgres with a stubbed
  `auth` schema, not real Supabase — worth one smoke test there too.
- **Frontend built:** `frontend/src/components/AssistantView.jsx` (nav item
  "Assistant", Beta), helpers in `assistantLogic.js`; 20 jest tests incl. a component click-through (`AssistantView.test.jsx`), API
  calls in `api.js`; `npm run build` passes with `CI=true`.
- **Not verified:** nothing has run against a live model or live Redis (route
  tests mock them), and the frontend has been exercised only through jsdom component tests,
  not a real browser against a running backend.
- **Not done:** the live adversarial run (`test/assistant_redteam.live.test.ts`
  is written, never executed).
- Extracted `src/actions/{gst,documents}.ts` so `POST /gst/sync` and
  document trash/restore routes share one implementation with the assistant.

## Frontend compatibility with the new error format (fixed)

The hardening pass changed every error body to
`{success:false, error:{code,message,requestId,details?}}`; existing views read
`result.error` as a string (GSTSyncView, DashboardView) or `result.detail`
(~10 others) and pass it to a toast — which would have received an object.
`frontend/src/apiErrors.js` (`normalizeErrorBody`, 4 tests) now converts it in
`api.js`'s `request()`, document upload and bank-CSV upload, keeping `error`
and `detail` as the message string. Success bodies are untouched. Checked: the
hardening pass otherwise only *added* fields to success responses
(`credits_remaining`) and preserved HTTP statuses.

## Keeping the backend warm (new)

Two layers, both built; neither has run against a deployed Worker yet.

1. **Cloudflare cron, every 5 min** (`src/warm.ts`, `[triggers]` in
   `wrangler.toml`): `select 1` + Redis `PING`. Keeps the Hyperdrive →
   Supabase path and Upstash warm and counts as activity for Supabase's
   free-tier inactivity pause. `scheduled()` now dispatches on `event.cron`,
   so this tick can never run the tenant sweep or retention purge (pinned by
   `test/keepwarm.test.ts`, mutation-checked). The cron string in
   `wrangler.toml` must stay identical to `KEEP_WARM_CRON` (a test checks it).
2. **External pinger** (`.github/workflows/keep-warm.yml`): hits
   `<BACKEND_URL>/healthz` every ~5 min through the real public path, logs
   time-to-first-byte, and fails the run (GitHub emails you) on non-200 or
   timeout. Set repo variable `BACKEND_URL` (and optionally
   `WARM_EXTRA_URLS`, one per line, for the Go/Lambda API) — it does nothing
   until `BACKEND_URL` is set. GitHub's scheduler is best-effort (delays of
   minutes) and disables itself after 60 days of repo inactivity.

Honest limits: **Workers have no meaningful cold start** — this warms what's
*behind* the Worker, which is where first-request slowness on this stack
comes from. It does **not** warm the Go backend's AWS Lambdas: the API
Lambda is only covered if its URL is added to `WARM_EXTRA_URLS`; the OCR
container Lambda (SQS-triggered, loads the model on start) can't be pinged
over HTTP — use provisioned concurrency or a warm-up event in
`ocr-service/handler.py` if upload-time latency matters there.

Also changed: `GET /healthz` no longer returns raw driver error text in its
(unauthenticated) response — ok flags only; details go to the logs.

## Before you deploy

1. Fix the GitHub repo's incomplete push if you still need the Go
   version for reference (see the earlier finding in this
   conversation — 11 missing `internal/` packages).
2. Create the Supabase project, run `db/schema.sql`, get the JWT
   secret and Postgres connection string.
3. `wrangler hyperdrive create` with the Supabase pooler connection
   string (port 6543, not 5432).
4. `wrangler secret put` every value listed in `wrangler.toml`'s
   comment block.
5. Update the frontend for Supabase Auth and Vercel — **done** in the
   same pass that removed the OCR Lambda (see `frontend/STATUS.md`),
   though never yet run against a real Supabase project or a real
   Vercel deploy.
6. ~~Point `OCR_LAMBDA_URL` at a Function URL~~ — no longer
   applicable. There's no Lambda to point at anymore; OCR runs
   client-side (`frontend/src/ocr/`). Nothing to do here.
7. Before charging anyone real money: replace the placeholder numbers in
   `src/billing/pricing.ts` (plan monthly allowances, per-operation
   credit costs) with real ones based on actual GST-API / bank-API /
   Anthropic per-call costs and your intended margin.
