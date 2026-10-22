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
      and pgbouncer's transaction mode don't get along. This also
      creates the `app_user` role that Row-Level Security depends on
      (see the next step — do not skip it).
- [ ] **Set `app_user`'s password and verify RLS actually works before
      going further.** `db/schema.sql` creates the role with no
      password on purpose, so a real one is never sitting in a file
      that gets committed:
      ```sql
      alter role app_user with password '<generate a strong random value>';
      ```
      Run that directly in the SQL Editor or via `psql` — not from a
      file you save. Then run the automated proof:
      ```
      psql "<direct connection string, as the postgres/owner role>" \
           -v ON_ERROR_STOP=1 -f db/rls_test.sql
      ```
      It should end with `ALL RLS TESTS PASSED`. If it doesn't, stop —
      don't proceed to Phase B with broken tenant isolation.
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
      Phase A — **as `app_user`, not `postgres`.** Connecting as
      `postgres` (a superuser) silently makes every RLS policy in
      `db/schema.sql` a no-op; this is the single most common way to
      "turn on RLS" and have it do nothing:
      ```
      wrangler hyperdrive create marginpulse-db \
        --connection-string="postgres://app_user:<password from Phase A>@aws-0-<region>.pooler.supabase.com:6543/postgres"
      ```
      Supabase's shared pooler sometimes expects the username as
      `app_user.<project-ref>` rather than plain `app_user` (the same
      convention it uses for `postgres.<project-ref>`) — check
      Settings > Database > Connection Pooling for the exact format
      your project expects once `app_user` exists, don't assume. Copy
      the returned Hyperdrive `id` into `wrangler.toml`'s
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
      degrades to rule-based summaries without it). Can be an
      OpenRouter key instead — set `ANTHROPIC_API_BASE_URL` to
      `https://openrouter.ai/api` and `ANTHROPIC_MODEL` to an
      OpenRouter-style provider-prefixed name (e.g.
      `anthropic/claude-sonnet-4.5`), not Anthropic's native model
      name. `insights.ts` sends both `x-api-key` and
      `Authorization: Bearer` on every call so either provider works
      without further code changes.
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
- [ ] Sign up two separate test users (two tenants) and confirm one
      cannot see the other's documents/dashboard through the API —
      the manual, over-HTTP complement to `db/rls_test.sql`'s
      database-level proof from Phase A.

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
- [ ] New: usage-based billing (`src/billing/`) has no real pricing yet
      — `src/billing/pricing.ts`'s plan allowances and per-operation
      credit costs are placeholder guesses. Set real numbers before
      charging anyone.
- [ ] New: no credit purchase/top-up flow. The ledger and wallet
      schema support a `PURCHASE` entry type; nothing calls it yet —
      needs a Razorpay/Stripe checkout wired to `reserveCredits`'s
      sibling (add a `purchaseCredits` function in
      `src/billing/credits.ts` when you build this).
- [ ] New: the frontend doesn't know about credits at all — no balance
      display, no handling of the new `402 INSUFFICIENT_CREDITS`
      response shape from `/gst/sync`, `/tax-identifiers`,
      `/bank-accounts`.
- [ ] New: error responses changed shape (see STATUS.md's "Centralized
      API error format" section) — same HTTP status codes as before,
      but the JSON body is now `{success, error: {code, message,
      requestId, details?}}` instead of each route's own ad hoc
      `{error: "..."}`. The frontend needs updating wherever it reads
      `err.error` as a string, and `credits_remaining` moved under
      `error.details` for the two `INSUFFICIENT_CREDITS` responses.
      **Done for the error body:** `frontend/src/apiErrors.js` normalizes it
      inside `api.js` (`error` and `detail` become the message string; the
      structured fields stay as `error_code`/`request_id`/`error_details`),
      so every existing view's toast keeps working. Nothing in the frontend
      reads `credits_remaining`, so that move is harmless today.
- [ ] New: no repository/pipeline code throws `AppError` yet — every
      route still does its own `if (!x) return apiError(...)` check.
      Worth doing where a failure can happen several calls deep and
      currently has to be checked-and-rethrown at every level between
      there and the route.
- [ ] New: soft-deleted documents (`deleted_at`) are only excluded from
      `listDocumentsByTenant`/`countDocumentsByTenant`. Reconciliation
      matching, GST cross-checks, and CSV/export queries in
      `repository/documents.ts` still include them — close this before
      a real user notices a "deleted" invoice still affecting their
      numbers.
- [ ] New: no orphan-file reconciliation between R2 and Postgres — the
      retention purge (`src/purge.ts`) only cleans up objects it can
      reach through a `documents`/`tenants` row. An R2 object left
      behind by some partial-failure upload path (upload succeeded,
      the following DB insert didn't) has no cleanup path yet.
- [ ] New: the purge job has no dry-run mode and no alerting beyond a
      `console.error` on failure — a tenant or document that fails to
      purge keeps retrying silently, once a day, forever.
- [ ] Still open: the queue consumer's per-message DB round trips for
      usage-event logging (see `queue/consumer.ts`) go through the same
      `max:1` Hyperdrive connection as everything else in this pass —
      fine at this app's current volume, worth revisiting only if a
      single batch's usage-event writes ever become a throughput
      bottleneck.

- [ ] New: **assistant — run the live red-team** before enabling Phase 2:
      `ANTHROPIC_API_KEY=... npx vitest run test/assistant_redteam.live`
      (written, never run — see `WORKFLOW.md` → "What's still open"). Keep
      `ASSISTANT_MUTATIONS_ENABLED = "false"` until it passes and Phase 1 has
      been used.
- [ ] New: click through the assistant in a real browser against a running
      backend (send, 402, confirm card, expiry) — covered by jsdom component
      tests only so far.
- [ ] New: smoke-test the assistant's SQL on real Supabase (verified on local
      Postgres 16 only).
- [ ] New: tune `ASSISTANT_MESSAGE` credit cost and the 0.02 USD budget
      estimate in `routes/assistant.ts`.

- [ ] New: **set the `BACKEND_URL` repo variable** (Settings → Secrets and
      variables → Actions → Variables) so `.github/workflows/keep-warm.yml`
      starts pinging; after the first deploy confirm a `keep_warm` log line
      appears every 5 minutes (`wrangler tail`).

- [ ] New: **time the dashboard on the real deployment** (cold and warm, e.g.
      Chrome DevTools → Network, throttled to Fast 3G): the changes are
      verified by tests, but the actual seconds haven't been measured. Expect
      the first paint to be instant; numbers arrive as the database answers.
- [ ] New: decide localStorage vs sessionStorage for the dashboard cache (see
      STATUS.md → "Dashboard load speed").
- [ ] New: Dashboard AI insight credit: the insight is now cached
      per distinct numbers; if you'd rather it never spend credits on page
      views at all, make `/dashboard-insight` opt-in from the UI.

- [ ] New: **confirm the backend URL** (open `<url>/healthz` in a browser —
      expect JSON with `"status":"ok"`), then use it for (a) the frontend's
      `REACT_APP_API_URL` (with `https://`, rebuilt/redeployed) and (b) the
      `BACKEND_URL` repo variable. `prod-marginpulse-frontend…workers.dev` serves
      the React app, not the API. Deploy the CORS change before testing from the
      workers.dev frontend.
- [x] `FRONTEND_ORIGIN` moved to `https://app.marginpulse.in`.
- [ ] New: in Supabase → Authentication → URL Configuration, set Site URL to
      `https://app.marginpulse.in` and allow-list it plus the workers.dev URL as
      redirect URLs (Google sign-in / email links).

- [ ] New: for the assistant to answer, the Worker needs the `ANTHROPIC_API_KEY`
      secret (`wrangler secret put ANTHROPIC_API_KEY`); without it the assistant
      replies 501 and charges nothing. `ASSISTANT_MUTATIONS_ENABLED` stays
      `"false"` until the live red-team has passed (see WORKFLOW.md).
- [ ] New: after any deploy, glance at the "Smoke test the live backend" step in
      the Actions run — PASS/FAIL/WARN per check is printed there.

## Quick file map

| Need to change... | Look in... |
|---|---|
| A route's behavior | `src/routes/<name>.ts` |
| A DB query | `src/repository/<entity>.ts` |
| Reconciliation/OCR/GST logic | `src/pipelines/<name>.ts` |
| A background job | `src/queue/consumer.ts` |
| Natural-language assistant | `src/assistant/*`, `src/routes/assistant.ts`, `WORKFLOW.md`, `test/` |
| Usage credits / pricing | `src/billing/pricing.ts` (numbers), `src/billing/credits.ts` (logic) |
| Tenant isolation / RLS | `db/schema.sql` (policies), `src/security/tenantContext.ts` (session vars), `db/rls_test.sql` (proof) |
| API error format | `src/errors.ts` (codes, AppError), `src/http.ts` (apiError helper) |
| Retention / deletion | `src/retention.ts` (grace periods), `src/purge.ts` (purge logic) |
| Auth/tenant loading | `src/auth/supabase.ts`, `src/middleware/auth.ts` |
| Schema | `db/schema.sql` (re-run changes manually — no migration tool is set up) |
