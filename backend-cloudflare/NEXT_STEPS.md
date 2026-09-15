# MarginPulse Pro on Cloudflare — Setup & Launch Checklist

Companion to `STATUS.md` (which says what's *done*). This is what's
left to *do*, in the order it actually has to happen — most steps
depend on the one before it. Check items off as you go; nothing here
is optional unless marked "(optional)".

---

## Phase A — Supabase project

- [ ] Create a Supabase project (or use an existing one).
- [ ] Run `db/schema.sql` against it — SQL Editor, or `psql` on the
      **direct** connection string (port 5432), not the pooler. DDL
      and pgbouncer's transaction mode don't get along.
- [ ] Authentication > Providers: enable **Email** (for
      signUp/signInWithPassword).
- [ ] Authentication > Providers: enable **Google** and **Apple** if
      you want social login — this is now entirely Supabase's
      configuration, not app code. You'll need OAuth client
      credentials from Google Cloud Console / Apple Developer for
      each.
- [ ] Authentication > URL Configuration: set your frontend's redirect
      URLs (needed for OAuth and email confirmation links to land
      back on your app).
- [ ] Settings > API: copy the **Project URL** and **JWT Secret** —
      you'll need both in Phase C.
- [ ] Settings > Database: copy the **pooler connection string**
      (port 6543, "Transaction" mode) — needed in Phase B.

## Phase B — Cloudflare resources

- [ ] `npm install -g wrangler` if you don't have it, then
      `wrangler login`.
- [ ] Create the R2 bucket: `wrangler r2 bucket create marginpulse-documents`
- [ ] Create Hyperdrive, pointed at the Supabase pooler string from
      Phase A:
      ```
      wrangler hyperdrive create marginpulse-db \
        --connection-string="postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres"
      ```
      Copy the returned `id` into `wrangler.toml`'s
      `[[hyperdrive]] id = "..."` line.
- [ ] Create the 5 queues + 5 dead-letter queues (10 total):
      ```
      wrangler queues create marginpulse-ocr
      wrangler queues create marginpulse-ocr-dlq
      wrangler queues create marginpulse-reconcile
      wrangler queues create marginpulse-reconcile-dlq
      wrangler queues create marginpulse-gst
      wrangler queues create marginpulse-gst-dlq
      wrangler queues create marginpulse-tax-identifier
      wrangler queues create marginpulse-tax-identifier-dlq
      wrangler queues create marginpulse-bank-account
      wrangler queues create marginpulse-bank-account-dlq
      ```

## Phase C — Secrets

Every value in `wrangler.toml`'s secrets comment block, via
`wrangler secret put <NAME>`:

- [ ] `SUPABASE_JWT_SECRET` — from Phase A
- [ ] `SUPABASE_SERVICE_ROLE_KEY` — from Phase A (Settings > API)
- [ ] `FIELD_ENCRYPTION_KEY` — generate 32 random bytes, base64-encode:
      `openssl rand -base64 32`. **Losing this key makes every
      encrypted bank account number unrecoverable — store it in a
      password manager, not just in Cloudflare.**
- [ ] `UPSTASH_REDIS_REST_TOKEN` — from your existing Upstash database
- [ ] `ANTHROPIC_API_KEY` — for dashboard insights (optional: app
      degrades to rule-based summaries without it)
- [ ] `GST_API_CLIENT_ID` / `GST_API_CLIENT_SECRET` / `GST_API_USERNAME`
      — from your GST portal API provider (optional: identity/GST-sync
      routes degrade to PENDING without it)
- [ ] `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` (optional, only if
      using the Razorpay connector — note the sync-side limitation in
      `STATUS.md`)
- [ ] `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` (optional)
- [ ] `SLACK_CLIENT_SECRET` (optional — Slack app credentials also
      need `slack_client_id`/`slack_redirect_uri` set via
      `PATCH /api/v1/admin/settings` once deployed, since those live
      in the `platform_settings` table, not a wrangler secret)
- [ ] `RESEND_API_KEY` (or swap providers in `src/email.ts` first)
- [ ] `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_ACCESS_TOKEN` (optional,
      only if using WhatsApp ingestion)
- [ ] `WHATSAPP_APP_SECRET` — Meta App Dashboard > your app >
      Settings > Basic > App Secret. Required to verify inbound
      WhatsApp webhooks; without it they're accepted unverified
      (logged each time). Only relevant if using WhatsApp ingestion.
- [ ] `WEBHOOK_INGEST_SECRET` (optional, only if using email ingestion)

Then update the plain (non-secret) values directly in `wrangler.toml`'s
`[vars]` block: `SUPABASE_URL`, `UPSTASH_REDIS_REST_URL`,
`GST_API_BASE_URL`, `FRONTEND_ORIGIN`, `INGEST_EMAIL_ADDRESS`.

## Phase D — ~~Bridge to the existing OCR Lambda~~ (removed — OCR is client-side now)

There is no OCR Lambda anymore, and nothing to bridge to. OCR runs
entirely in the browser (`frontend/src/ocr/` — Shape Detection API
primary, Tesseract.js WASM fallback, `pdfjs-dist` for PDF
rasterization) because there was no AWS account available for this
deployment. `OCR_LAMBDA_URL` and `OCR_LAMBDA_AUTH_TOKEN` no longer
exist in `config.ts` or `wrangler.toml` — skip this phase entirely.

One thing worth doing that isn't done yet: **test the client-side OCR
against real scanned/photographed invoices**, not just confirm the
frontend build compiles. Tesseract.js/TextDetector's real-world
accuracy on messy documents hasn't been checked — see
`frontend/STATUS.md`'s known gaps.

## Phase E — Local verification

- [ ] `npm install`
- [ ] `npx tsc --noEmit` — should pass clean (it did when this was
      built; if you've edited anything, re-check).
- [ ] `wrangler dev` — smoke-test `GET /healthz` locally.
- [ ] Get a real Supabase access token (sign up a test user via the
      Supabase JS client or REST API) and confirm
      `GET /api/v1/auth/me` creates a tenant row and returns it.
- [ ] Upload a test document via `POST /api/v1/documents/upload` and
      confirm: R2 has the object, the OCR queue receives a message,
      and (once the consumer runs) the document ends up `PARSED` with
      extracted fields.

## Phase F — Frontend changes (required, not optional)

The React app in `frontend/` was never touched — it still expects the
old REST auth flow. Concretely:

- [ ] Add `@supabase/supabase-js`, initialize a client with the
      Supabase URL + anon key.
- [ ] Replace `frontend/src/api.js`'s register/login/refresh calls
      with `supabase.auth.signUp` / `signInWithPassword` /
      `refreshSession` / `signOut` / `signInWithOAuth('google' | 'apple')`.
- [ ] Replace `frontend/src/security/tokenManager.js`'s token storage
      with reading `session.access_token` from Supabase's own session
      object (it manages refresh timing itself).
- [ ] Every other API call in `api.js` keeps working as-is — the
      route paths and request/response shapes were deliberately kept
      close to the original specifically to minimize this list.
- [ ] Update the "accept invite" flow to call
      `POST /api/v1/team/accept-invite` **after** the user has
      completed Supabase sign-up/sign-in, not instead of it.

## Phase G — Deploy to staging

- [ ] `wrangler deploy` to a staging environment/subdomain.
- [ ] Point a local frontend build's API URL at the staging Worker and
      run through: sign up → upload a document → see it reconciled →
      view the dashboard.
- [ ] Trigger each queue task at least once (upload a document for
      OCR, add a tax identifier for verification, add a bank account
      for verification, run a GST sync if you have real GST API
      credentials) and check `wrangler tail` for errors.

## Phase H — Cutover

- [ ] Point production DNS / the real frontend's API URL at the
      Workers deployment.
- [ ] Keep the old AWS stack (API Gateway, Lambda, DynamoDB, SQS)
      running but idle for a rollback window — don't tear it down
      same-day.
- [ ] Once confident: decommission API Gateway, the `api`/`worker`
      Lambdas, DynamoDB, and SQS — **including the OCR Lambda**. It's
      no longer used at all (OCR is client-side now, see `STATUS.md`'s
      update note) — there's no "leave it running permanently"
      exception anymore.

---

## Known gaps worth closing before you rely on them in production

Cross-referenced from `STATUS.md` — repeated here so they show up in
a task list, not just prose:

- [x] Razorpay sync was blocked (HTTP 501) — **fixed**: credentials
      now go in a new `credentials_encrypted` JSON column instead of
      the old concatenated string. See `src/repository/integrations.ts`
      and `src/routes/integrations.ts`. If you already ran the old
      `schema.sql` on a live Supabase project, add the column by hand
      (see `db/schema.sql`'s comment) — it was edited in place, not
      shipped as a migration, since no migration tool exists here.
- [ ] Bank-account name-match now normalizes and fuzzy-matches instead
      of a bare substring check (`src/pipelines/identity.ts`,
      threshold 0.82) — better, but still not a faithful port of
      whatever `identity.go`'s original comparison did, since that
      logic wasn't visible in the source this was ported from. PAN
      verification still does no name-match at all (unchanged,
      already true before).
- [x] WhatsApp webhook `X-Hub-Signature-256` verification — **fixed**:
      implemented in `src/routes/webhooks.ts` using a new
      `WHATSAPP_APP_SECRET` secret (HMAC-SHA256, constant-time
      compare). Falls back to unverified (with a logged warning) if
      the secret isn't set. Add `WHATSAPP_APP_SECRET` to the Phase C
      checklist below before relying on this in production.
- [ ] The GitHub repo's own push is still missing ~11 `internal/`
      packages (from the very first finding in this conversation) —
      worth fixing if you ever need the Go version as a reference
      again.

## Quick file map

| Need to change... | Look in... |
|---|---|
| A route's behavior | `src/routes/<name>.ts` |
| A DB query | `src/repository/<entity>.ts` |
| Reconciliation/OCR/GST logic | `src/pipelines/<name>.ts` |
| A background job | `src/queue/consumer.ts` |
| Auth/tenant loading | `src/auth/supabase.ts`, `src/middleware/auth.ts` |
| Schema | `db/schema.sql` (re-run changes manually — no migration tool is set up) |
