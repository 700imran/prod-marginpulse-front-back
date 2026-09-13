# MarginPulse Pro on Cloudflare — Status

Full rewrite of `backend/` (Go, AWS Lambda) to TypeScript on Cloudflare
Workers, with Supabase (Auth + Postgres) replacing DynamoDB and custom
JWT auth, and R2 replacing S3. This is a from-scratch TypeScript
project — it does not touch the original Go code.

**Independently re-verified in a follow-up pass** (not just trusting
the claims above): `package.json`'s dependency list is `hono` +
`postgres` + `jose` only — no `aws-sdk` anywhere, confirmed with a
recursive grep for `aws-sdk|dynamodb|s3client|amazonaws` across `src/`
and both package files (zero matches). `wrangler.toml` uses R2,
Hyperdrive→Supabase Postgres, Cloudflare Queues, and Cron
Triggers — no AWS resources. The **only** remaining AWS touchpoint in
the entire codebase is `OCR_LAMBDA_URL`: one plain `fetch()` call with
a bearer token in `src/pipelines/ocr.ts`, not the AWS SDK and not
SigV4. That's the deliberate, documented exception below (RapidOCR/
PyMuPDF can't run on Workers) — not an accidental AWS dependency. This
codebase has no Vercel-related files because it's backend-only; the
frontend (where a Vercel deploy target would live) isn't part of this
handover zip — see "Not ported at all" below.

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
  cross-verify), `ocr.ts` (calls the kept-on-AWS Lambda + all regex
  extraction), `insights.ts` (AI dashboard summary + collection
  scripts), `missingInvoice.ts`, `dashboard.ts`
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
6. **OCR stays on AWS Lambda, reached over HTTPS via a Function URL**
   instead of the SDK `Invoke` API — Workers have no AWS credentials to
   sign a SigV4 request with. `RapidOCR` (native ONNX binary) and
   `PyMuPDF` (C-extension wheel) categorically cannot run on Workers —
   this is a platform ceiling, not an effort gap. **Confirmed earlier
   in this conversation: OCR currently handles 100% of both PDF and
   image volume** — the client-side OCR work referenced in earlier
   session notes isn't in this repo or its own handover zip, so treat
   the Lambda as load-bearing, not a rare exception path, until that
   client-side work actually exists somewhere.

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
5. Update the frontend for Supabase Auth — this is required, not
   optional, before anything logs in successfully.
6. Point `OCR_LAMBDA_URL` at a Function URL on the existing AWS OCR
   Lambda (auth type NONE + the bearer token this code sends, or put
   it behind API Gateway with a usage-plan key instead).
