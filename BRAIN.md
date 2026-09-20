# BRAIN.md — Engineering Handover

> ## ⚠️ READ THIS FIRST — Architecture moved since the rest of this file was written
>
> Everything below (`Current Architecture`, `Folder Structure`, `Next 10
> Tasks`, etc.) describes the **old Go + AWS Lambda + DynamoDB** stack
> under `/backend`. **That is not what's live in production anymore.**
> The actual live stack today is:
>
> - **Frontend**: `frontend/` (unchanged CRA app), deployed on **Vercel**
>   (project `marginpulse-app`, auto-deploys from `main`).
> - **Backend**: `backend-cloudflare/` — a Cloudflare Worker
>   (`prod-marginpulse-front-back`), Hono-style routing. This is what
>   actually serves `/api/v1/...` in production now, **not** `/backend`.
> - **Database/Auth**: Supabase (project `marginpulse-pro`,
>   ref `nseurvhbqkdlemcfoixt`) — Postgres + Supabase Auth
>   (email/password + Google OAuth, both via `supabase-js` directly from
>   the frontend, not through the Worker).
> - **DB connection**: Cloudflare Hyperdrive (`marginpulse-db`) sits in
>   front of Supabase's connection pooler
>   (`aws-0-ap-south-1.pooler.supabase.com:6543`).
> - **File storage**: Cloudflare R2 bucket `marginpulse-documents`
>   (replaces S3).
> - **CI/CD**: `.github/workflows/deploy-worker.yml` — pushing to `main`
>   under `backend-cloudflare/**` auto-runs `wrangler deploy` (needs the
>   `CLOUDFLARE_API_TOKEN` repo secret, already configured).
>
> **`/backend` (Go/DynamoDB/SQS/SAM)'s current status is unknown** — it
> may be fully abandoned, or it may still hold logic (e.g. the
> reconciliation matching engine, GST sync heuristics) that hasn't been
> ported to `backend-cloudflare/` yet and needs auditing feature-by-
> feature. **Don't assume anything in section D below ("Completed
> Modules") is actually live** — it describes what the Go backend had,
> not what `backend-cloudflare/` has today. This needs a real audit as
> a next step (not done in this pass — see "Open flags" below).
>
> What got fixed in the Cloudflare/Supabase/Vercel stack this session,
> in order: (1) frontend showed a blank white screen — root cause was
> missing `REACT_APP_SUPABASE_URL`/`REACT_APP_SUPABASE_ANON_KEY` Vercel
> build env vars, plus `REACT_APP_API_URL` missing its `https://`
> scheme; (2) Hyperdrive was pointed at Supabase's direct connection
> (`:5432`) instead of the pooler (`:6543`) — fixed; (3) Worker's
> `SUPABASE_URL`/`FRONTEND_ORIGIN` vars were still template placeholders
> — fixed; (4) login was 100% failing with 401s — the Worker verified
> tokens as HS256 against a shared secret, but this Supabase project
> (created after Oct 1, 2025) issues asymmetric-signed tokens by
> default — rewrote `backend-cloudflare/src/auth/supabase.ts` to verify
> via JWKS (`createRemoteJWKSet`), accepting both RS256 and ES256; (5)
> Google/Apple OAuth buttons in `LoginPage.jsx` were dead links to Go-
> backend routes that don't exist on the Worker — rewired to call
> `supabase.auth.signInWithOAuth()` directly, matching how
> email/password login already works. Google OAuth is now enabled in
> Supabase; **Apple OAuth is not yet enabled** (needs a paid Apple
> Developer account + Services ID — external, not doable via API).
>
> ## This pass (frontend visual/branding pass)
>
> Scope was deliberately narrow, per explicit instruction: **frontend
> only** — no ML models, no new backend features this pass.
>
> 1. **Re-synced `frontend/src/theme.js`'s color palette to the
>    marketing site's** (`marginpulse.page` repo, `css/global.css`).
>    The app was using an unrelated bright-green (`#00c07f`)/purple
>    palette; the marketing site's actual brand is slate
>    (`#0f172a`)/teal (`#0d9488`). All `--primary-color` etc. tokens and
>    every hardcoded green hex/rgba in `theme.js` were switched to the
>    teal/slate equivalents. Card/button border-radius was also nudged
>    from 16px toward the marketing site's 14px for a closer visual
>    match.
> 2. **Sidebar logo mark now matches the marketing site's exactly**:
>    a slate (`#0f172a`) rounded square with a bold white "M", instead
>    of the previous unlabeled skewed teal shape (copied from
>    `marginpulse.page/js/components.js`'s `.nav-logo-mark`).
> 3. **Sidebar collapse behavior** (`App.jsx` + `theme.js`): collapsed
>    state is now a 76px logo-only rail — nav items are fully hidden,
>    not just icon-only as before. Hovering the collapsed rail expands
>    it to 240px and reveals full nav (icons + labels), matching what
>    was asked for ("logo icon when closed, sidebar icon only on hover
>    or click"). The manual toggle button still exists for a permanent
>    pin open/closed. **Known trade-off**: this is a normal-flow width
>    change, so hovering does shift `main-content` slightly rather than
>    floating over it as an absolute overlay — acceptable for now, a
>    non-reflowing overlay version would be a nice later polish.
> 4. **Feature tier labels added** to `NAV_SECTIONS` in `theme.js`,
>    based on the Free/Pro/Growth/Scale strategy doc the product owner
>    provided this session (see "Open flags" — this strategy conflicts
>    with the live marketing site's actual pricing page):
>    - No badge (implicitly Free/core): Dashboard, Documents Matrix,
>      ROI Calculator, Profile, Tax IDs & Bank Accounts, Security,
>      Billing & Plans (billing had an incorrect "Pro" badge before
>      this pass — fixed, since gating billing itself behind a paid
>      plan makes no sense).
>    - **Pro** badge: Tax Portal Sync (GST), Reconciliation Rules,
>      Audit Trail.
>    - **Growth** badge: API & Integrations, Notifications, Audit Team.
>    - No **Scale**-tier UI exists yet to label (revenue leakage,
>      advanced anomaly engine, portfolio dashboard — none of these
>      screens exist in the app yet, so there's nothing to badge; this
>      naturally satisfies "don't show more features until production
>      ready" since they're simply not built).
>    - **These badges are cosmetic/informational only — not enforced.**
>      There is no `plan`/`subscription_tier` column anywhere in the
>      Supabase schema (`tenants` table has no such field) and no
>      billing-status check gating any route or component. A user on
>      any plan can currently click into every "Pro"/"Growth"-badged
>      screen and it will work. Real enforcement is backend work, not
>      started.
> 5. **Fixed the still-open favicon/manifest gap** flagged earlier this
>    session but never actually fixed: generated a real icon set (same
>    slate-square-with-"M" mark, sizes 16/32/48/180/192/512) into
>    `frontend/public/`, added `favicon.ico`, `apple-touch-icon.png`,
>    `manifest.json`, and the corresponding `<link>`/`<meta>` tags in
>    `index.html`. Also deleted a stray 1-byte junk file
>    (`public/redfs.md`) found sitting in the repo.
> 6. Verified with a real `CI=true npm run build` — compiled
>    successfully, no regressions.
>
> ## Open flags — decisions needed before the next pass goes further
>
> - **Pricing/plan-structure conflict, unresolved**: the strategy doc
>   used to badge features this pass proposes **Free → Pro ₹999 →
>   Growth ₹2,499 → Scale ₹4,999+**, aimed at individual CAs bottom-up.
>   The **live marketing site's actual `pages/pricing.html`** has a
>   completely different structure already published: **Solo / Growth
>   / CA Firm / Large Firm**, starting at **₹15,000/month** — a
>   top-down enterprise-ish model. These are not reconcilable as
>   written. The in-app tier badges added this pass follow the
>   strategy doc's tier *names* (Free/Pro/Growth/Scale) since that's
>   what was explicitly asked for, but **the marketing site was not
>   touched or reconciled to match** — someone needs to decide which
>   pricing model is actually going to market before the two surfaces
>   can be made to genuinely "cooperate," and before real backend plan
>   enforcement is built against either one.
> - **`/backend` (Go) vs `backend-cloudflare/` feature parity: unaudited.**
>   Needs a side-by-side pass to confirm which of section D's
>   "✅ Complete" modules actually exist in `backend-cloudflare/` today.
> - **Per-page tier badges are a coarse first pass**, not a real
>   feature-level audit. E.g. "Dashboard" is unbadged/Free but likely
>   contains some genuinely Pro-tier widgets (ITC risk detail) mixed
>   with genuinely-Free ones (basic counts) — splitting that requires
>   component-level work, not a nav-level badge.
> - **Apple OAuth still not enabled** (needs external paid Apple
>   Developer setup).
> - **Marketing site itself untouched this pass** — it was already the
>   correct brand reference (teal/slate), so the fix direction was
>   "make the app match the marketing site," not the reverse. If the
>   marketing site's pricing page changes per the flag above, its own
>   HTML/CSS will need edits too — that's a separate repo
>   (`marginpulse.page`), not covered by this pass's push.
>
> ## Follow-up pass (same day) — sidebar fix, real brand colors, perf, a real data bug, charts
>
> 1. **Sidebar bug fix.** The hover-to-expand collapsed rail from the
>    prior pass was wrong — clicking to close while the cursor stayed
>    on the sidebar/toggle button meant the `:hover` CSS kept it visually
>    open (only the wordmark text, which had no hover override, actually
>    hid). Removed all hover-driven expand/collapse CSS. Now **pure
>    click-only**: collapsed = logo/toggle button only, nothing else in
>    the DOM shows; expanded = full nav. Also fixed `.sidebar`'s
>    `overflow: hidden`, which was clipping nav items below the
>    viewport instead of scrolling — now `overflow-y: auto`. The logo
>    and the sidebar-toggle button were merged into one button that
>    shows the brand mark by default and crossfades to a menu icon on
>    hover (hover here is just a "click me" visual hint, scoped to that
>    one button — it does not open/close anything by itself).
> 2. **Real brand colors, from the official guide — this replaces the
>    approximated marketing-site colors from the prior pass.** The user
>    provided the actual "MarginPulse Integrated Branding and Design
>    Guide" plus branded Letterhead/Invoice `.docx` templates. Exact
>    values now in `theme.js`: Primary Teal `#18c496` (was approximated
>    as `#0d9488`), Dark Gray `#333333` for body text (was approximated
>    as slate `#0f172a`), Neutral Beige `#f5f1eb` as the page background
>    (was cool slate-gray `#f1f5f9`), Mint Support `#aee9da`, Deep Navy
>    `#1a3e5c` (reserved for reverse/dark panels, not used yet). One
>    correction from the letterhead/invoice reference: the "Margin" half
>    of the wordmark is a dark **teal**, not gray — `--primary-dark`
>    (`#0f6e56`, derived) is used there, not `--text-dark`. The brand
>    icon (bars + upward arrow) was regenerated with the exact gradient
>    (`#aee9da` → `#18c496`) across the favicon/manifest/sidebar mark.
>    **Standing note for future passes**: this hand-derived approximation
>    from a flattened image is not a pixel-perfect vector trace of
>    whatever the original design file is — if an actual `.ai`/`.svg`
>    source of the logo exists, use that instead next time it's
>    available.
> 3. **Load-time**: all 13 (now 14, with the charts file) screens
>    converted to `React.lazy` + `Suspense` in `App.jsx` instead of one
>    eager bundle. Verified via `CI=true npm run build`: main bundle
>    269.7KB gzipped (down from 282.6KB), 14 small per-screen chunks
>    that only load on navigation.
> 4. **Found and fixed a real, significant bug — not a speed issue.**
>    `DashboardView.jsx` was written against the old Go backend's
>    snake_case JSON and never updated when `backend-cloudflare` (which
>    returns camelCase almost everywhere) went live. Net effect before
>    this fix: **the dashboard's 4 headline stat cards, the entire
>    "Today's Priorities" ITC-risk/vendor-followup/filing-deadline
>    section, the AI plain-English insight banner, and the "Mark
>    Resolved" button on anomalies were all silently broken** — reading
>    fields like `summary_metrics`, `plain_english_insight`,
>    `highest_itc_risk_today`, `anomaly_id` off responses that actually
>    contain `summaryMetrics`, `plainEnglishInsight`,
>    `highestItcRiskToday`, `anomalyId`. Fixed every instance in this
>    file (cross-checked against the actual `backend-cloudflare`
>    interfaces in `src/pipelines/dashboard.ts` and
>    `src/repository/anomalies.ts`, not guessed). **Two endpoints
>    genuinely do return snake_case on purpose**
>    (`/reconciliation/detect-missing-invoices`'s
>    `anomalies_created`/`bank_transactions_scanned`, and
>    `/gst/sync-portal`'s `job_id`) — those were left alone, correctly.
>    **Update: this was extended to the whole app in the next pass below
>    (item 8) — no longer just `DashboardView.jsx`.**
> 5. **Charts added** (`frontend/src/components/charts/index.jsx`, new
>    `recharts` dependency): `StatusDonut` and `RiskBarChart`, built
>    generic (`{label, value}[]` props) on purpose so the same
>    components drop into a future multi-client/portfolio dashboard
>    without rework — see `docs/COMMERCIAL_ROADMAP.md`. Wired into
>    `DashboardView.jsx` using the now-fixed real data. Cost: recharts
>    adds ~118KB gzipped, but it's isolated to the Dashboard's own lazy
>    chunk (see #3), not the initial app-shell load.
> 6. **`docs/COMMERCIAL_ROADMAP.md` created** — the CA-workflow/pricing-
>    tier engineering backlog promised a couple of passes ago and not
>    delivered until now (multi-client portfolio, action queue, vendor
>    follow-up automation, team assignment, revenue leakage, etc., each
>    mapped to what already exists vs. what's net-new). It also corrects
>    a wrong claim from the prior BRAIN.md pass: `tenants.plan_tier`
>    **does** exist in the schema (`FREE/STARTER/GROWTH/ENTERPRISE`) —
>    a third tier-naming scheme on top of the marketing site's and the
>    strategy doc's — it's just never checked anywhere, so enforcement
>    is still not real. Read that file before touching pricing/tiers
>    again.
> 7. **Standing guardrail, not just for this pass**: the Letterhead/
>    Invoice `.docx` templates and anything described as a "pitch deck"
>    are external/investor-facing presentation material, not
>    documentation of the actual system. Don't treat them as a source
>    of truth for what the app does, and don't let pitch-appropriate
>    simplification bleed into how the real architecture gets described
>    elsewhere (this file, `docs/`, code comments). They're a UI/brand
>    reference only.
>
> Next 10 Tasks below (section H) predates this pass and is about the
> old Go/AWS backend — treat it as historical until someone re-derives
> a task list against `backend-cloudflare/`'s actual current state.
>
> ## Follow-up pass 2 (same day) — the camelCase bug, app-wide
>
> 8. **Extended the DashboardView field-name audit to all 13 screens.**
>    Reported symptom: "profile name/icon never loads, stuck on
>    Loading forever" — traced to the exact same bug class as item 4
>    above, but in `App.jsx`'s header (`tenant?.display_name` etc. —
>    the literal string `"Loading…"` was the permanent fallback since
>    `tenant` never populated) and `ProfileView.jsx`. Given how
>    systemic this turned out to be, audited **every** component file
>    against the real backend field names (pulled all ~104
>    `snake_case as "camelCase"` SQL aliases from `backend-cloudflare/
>    src/repository/*.ts` in one pass as a source-of-truth dictionary)
>    and fixed every file: `App.jsx`, `ProfileView.jsx`,
>    `AdminPanelView.jsx`, `DocumentsView.jsx`, `GSTSyncView.jsx`,
>    `TaxBankView.jsx`, `TeamView.jsx`, `AuditLogView.jsx`,
>    `NotificationsView.jsx`, `ReconciliationRulesView.jsx`,
>    `IntegrationsView.jsx`, `BillingView.jsx`.
>    - **Important nuance, don't blindly camelCase everything**: several
>      endpoints deliberately use snake_case on purpose and must stay
>      that way — `ROICalculatorView.jsx` is entirely snake_case
>      end-to-end (its own `POST /roi` route, both request and
>      response) and needed **no changes at all**. The tax-identifier
>      and bank-account **creation forms** (`taxForm`/`bankForm` in
>      `TaxBankView.jsx`) also correctly send snake_case
>      (`id_type`/`id_value`, `bank_name`/`account_holder_name`/
>      `account_number`/`ifsc_code`/`account_type`) because those two
>      POST routes manually destructure snake_case from
>      `c.req.json()` — but the **list responses** for the same two
>      resources are camelCase (SQL-aliased), so the same file has both
>      conventions side by side depending on read vs. write. Same
>      pattern in `AdminPanelView.jsx`'s Slack/platform-settings section
>      (`/admin/settings` hand-rolls snake_case both ways on purpose)
>      and `IntegrationsView.jsx`'s credential fields (`key_id`/
>      `key_secret`/`secret_key` — these intentionally mirror
>      Razorpay/Stripe's own field names, not this app's convention).
>      **Before touching any endpoint's field names again, check
>      whether it's a raw `c.req.json()` destructure (snake_case) vs.
>      a repository SQL-aliased return (camelCase) — don't assume one
>      convention app-wide.**
>    - Also found and left alone (out of scope, separate small gaps):
>      `AdminPanelView.jsx`'s Google/Apple OAuth credential UI has *no
>      backend at all* to connect to any more — a code comment in
>      `admin.ts` confirms those fields were deliberately dropped since
>      Google/Apple auth now goes through Supabase directly (consistent
>      with how OAuth login was fixed earlier this session). That UI
>      section is vestigial and should probably be removed, not fixed.
>      Separately, `/admin/settings` never returns `updated_at`/
>      `updated_by` even though the DB column is written — minor
>      backend gap, "last updated by" text just never shows.
> 9. User also deployed the frontend to **Cloudflare** (Worker
>    `prod-marginpulse-frontend`) — build failed, live script is still
>    the default `wrangler init` "Hello world" placeholder, meaning no
>    real deploy has ever succeeded there. Cloudflare doesn't expose
>    build logs through any tool available this session — whoever picks
>    this up needs the actual error from Cloudflare Dashboard → Workers
>    & Pages → `prod-marginpulse-frontend` → Deployments → the failed
>    one → logs. Likely candidate causes, unconfirmed: deploying a CRA
>    build to a Worker needs a `wrangler.toml` with an `[assets]`
>    binding pointing at the `build/` folder (Cloudflare **Pages** is
>    the simpler, purpose-built option for a static SPA — a plain
>    Worker needs this configured manually); could also be the same
>    missing-build-env-var class of bug chased earlier for Vercel,
>    independently, since Cloudflare's env vars for this Worker are a
>    separate configuration from Vercel's. **Update: user reports this
>    is now deployed successfully** (confirmed indirectly — the Worker's
>    `modified_on` timestamp is fresh and `workers_get_worker_code` now
>    errors trying to parse it as a single script instead of returning
>    the old placeholder, consistent with real static assets now being
>    there — couldn't verify by actually viewing the rendered page).
> 10. **Landing page branding sync — done, pushed to `marginpulse.page`
>     repo (separate repo, separate token from the main app repo).**
>     Corrected the same approximated colors there too (the marketing
>     site was the original reference for the app's colors, but it had
>     the same `#0d9488`-ish approximation, not the exact `#18c496` from
>     the official brand guide — fixed both together, everywhere the
>     hex was hardcoded, not just the CSS variable). Replaced the plain
>     "M" logo mark (in `js/components.js`, the shared nav/footer
>     template used by all 19 pages) with the real bars+arrow icon —
>     matches the app's sidebar mark exactly now. Also added a favicon/
>     apple-touch-icon site-wide (it had none at all before, same gap
>     the app had at the start of this whole session). **Caveat**: this
>     is pushed to GitHub, but whether the live
>     `marginpulse-page.imrankhan210r.workers.dev` Worker auto-deploys
>     from a git push or needs a manual `wrangler deploy` is unknown —
>     unlike the backend Worker, no GitHub Actions workflow was set up
>     for this repo this session.

**Read this first.** This document assumes you have no access to any
prior conversation about this project. Deeper detail on every section
below lives in `docs/` — this file is the map, `docs/` is the
territory.

---

## A. Project Summary

**Purpose**: MarginPulse Pro automates GST/bank/transaction
reconciliation for Indian SMBs, and — more importantly to the product
direction — surfaces the result as a prioritized daily action list
(highest ITC risk, vendors to follow up, filing deadlines, recoverable
ITC), not a raw mismatch report. Product positioning: a **Financial
Risk Intelligence Platform**, marketed as decision intelligence for
finance teams ("know exactly where your money, ITC, and compliance
risk are before filing"), not "another reconciliation tool." Full
detail: `docs/BUSINESS_OVERVIEW.md`.

**Target users**: Indian SMB owners/finance leads doing GST/bank
reconciliation manually today, and CA firms managing reconciliation for
multiple SMB clients (CA-enablement is a first-class use case, not an
afterthought).

**Main features**: document upload + OCR, automated bank reconciliation
(fuzzy vendor/amount/date matching), GST portal sync (vendor filing
status), the ITC-risk daily dashboard, manual correction workflow,
duplicate/missing invoice detection, downloadable CSV reconciliation
report, complete audit trail, an ROI calculator, team accounts,
tax-identifier/bank-account management, a platform admin panel, and
Slack/Razorpay/Stripe/Google/Apple integrations.

---

## B. Current Architecture

**Frontend**: Plain Create React App (React 18, no Next.js, no CSS
framework — hand-written CSS-in-JS theme in `src/theme.js`). No
client-side router; nav is a `useState` string switched in `App.jsx`.
All API calls centralized in `src/api.js`.

**Backend**: Go 1.22, stdlib `net/http.ServeMux` pattern routing, no
external router/framework. Two Lambda entry points
(`cmd/api`, `cmd/worker`) sharing all `internal/` packages, plus
`cmd/localserver` for local dev (identical handlers, no AWS needed).
This is a from-scratch rewrite of an earlier Python/FastAPI/Celery
codebase — see `docs/DECISIONS.md` #1 for why.

**Database**: DynamoDB, single table + 3 GSIs, deliberately designed to
fit AWS's always-free tier as one account-wide capacity budget. No
relational DB, no ORM. Full key design: `docs/DATABASE_SCHEMA.md`.

**Queues**: 5 SQS queues (OCR, reconciliation, GST sync,
tax-identifier verification, bank-account verification), each
triggering its own Lambda **function resource** but all running the
**same** `cmd/worker` container image — routing happens inside the Go
binary by reading a `task` field from the message, not via different
images per queue.

**Authentication**: JWT access+refresh pair (bcrypt passwords), Google
+ Apple OAuth (Redis-backed CSRF state), Redis-backed token
revocation blocklist on logout. Multi-tenant: one `TenantContext` per
request; **no separate per-team-member identity yet** — every action
attributes to the tenant owner's email (known gap, see
`docs/SECURITY.md`).

**AI pipeline**: Two genuinely separate things, don't conflate them:
1. **OCR** (deterministic, no LLM): Go worker → AWS Lambda Invoke → a
   small separate Python Lambda (`ocr-service/`) running the real
   `rapidocr-onnxruntime` package. PDFs are rasterized to images with
   **PyMuPDF** inside that same Lambda first (pip-only, free/open
   source, no system packages, no paid cloud OCR API — this was an
   explicit, confirmed product requirement; see `docs/DECISIONS.md` #3
   for the full story including a Textract integration that was built
   and then deliberately reverted).
2. **Dashboard insight** (the only actual LLM call in the codebase):
   Anthropic API, one call per dashboard load, turning summary numbers
   into one plain-English paragraph. Budget-capped per tenant
   (`internal/aibudget`). Reconciliation matching itself is pure Go
   arithmetic (Levenshtein + weighted scoring) — not LLM-based, on
   purpose (cost, speed, auditability — see `docs/SYSTEM_DESIGN.md`).

**Deployment**: SAM/CloudFormation templates in `infra/`
(`dynamodb-table.yaml` → `api-template.yaml` → `worker-template.yaml`,
in that order). Frontend is a static build deployed anywhere
(Cloudflare Pages/Vercel/S3+CloudFront). No CI/CD pipeline exists yet
— every deploy today is manual CLI. Full walkthrough:
`docs/DEPLOYMENT.md`.

---

## C. Folder Structure

```
/
├── README.md
├── BRAIN.md                          ← this file
├── docs/                              14 reference docs (see README.md's index)
├── backend/
│   ├── .env.example                   Full env var reference with comments
│   ├── DYNAMODB_SCHEMA.md             (superseded by docs/DATABASE_SCHEMA.md — kept for history)
│   ├── ADMIN_PANEL.md
│   ├── README.md                      (backend-specific, partially stale — docs/ is authoritative)
│   ├── go.mod / go.sum
│   ├── cmd/
│   │   ├── api/            Dockerfile, main.go            — API Lambda entry
│   │   ├── worker/         Dockerfile, main.go            — worker Lambda entry, task dispatch()
│   │   └── localserver/    main.go                        — local dev HTTP server
│   ├── internal/
│   │   ├── config/         config.go                      — all env vars, one Settings struct
│   │   ├── db/              dynamodb.go                    — key builders (single source of truth)
│   │   ├── repository/     one file per entity (documents, anomalies, auditlog, banktransactions,
│   │   │                    bankaccounts, taxidentifiers, teammembers, tenants, settings,
│   │   │                    platform_settings, integrations, types.go, sortutil.go)
│   │   ├── httpapi/        router.go + middleware.go + one *_handlers.go file per resource area
│   │   │                    (auth, document, dashboard, reconciliation, audit, roi, gst,
│   │   │                     tax_identifier, bank_account, settings, team, integration,
│   │   │                     oauth, webhook, admin, comms, health, response.go)
│   │   ├── pipelines/
│   │   │   ├── ocr/              ocr.go — RapidOCR Lambda invocation + regex field extraction
│   │   │   ├── reconciliation/   reconciliation.go, dateutil.go — matching engine
│   │   │   ├── dashboard/        insights.go — ITC-risk daily dashboard
│   │   │   ├── exceptions/       missing_invoice.go — missing-invoice detection heuristic
│   │   │   ├── insights/         insights.go — Anthropic API plain-English dashboard paragraph
│   │   │   ├── gstsync/          gstsync.go — GST portal sync
│   │   │   └── identity/         identity.go
│   │   ├── security/       password.go, jwt.go, fieldencryption.go, tokenblocklist.go, random.go
│   │   ├── oauth/           google.go, apple.go, state.go
│   │   ├── integrations/    connector.go, razorpay.go, stripe.go, slack.go, stub.go
│   │   ├── queue/           queue.go — SQS publish, one Enqueue* func per task type
│   │   ├── storage/         storage.go — S3 + local filesystem dual-mode
│   │   ├── email/           email.go — SMTP sending
│   │   ├── ratelimit/       ratelimit.go — Redis fixed-window rate limiting
│   │   ├── aibudget/        aibudget.go — per-tenant LLM token/cost guard
│   │   ├── platformsettings/platformsettings.go
│   │   └── logging/         logging.go — structured JSON logging (log/slog)
│   ├── ocr-service/          Dockerfile, handler.py, requirements.txt — separate Python Lambda
│   └── infra/
│       ├── dynamodb-table.yaml   Deploy 1st — table + 3 GSIs
│       ├── api-template.yaml     Deploy 2nd — API Lambda + HTTP API
│       └── worker-template.yaml  Deploy 3rd — 4 worker Lambdas + OCR Lambda + 5 SQS queues
└── frontend/
    ├── package.json / package-lock.json
    ├── public/index.html
    └── src/
        ├── App.jsx              Nav switch, toast state, OAuth callback consumption
        ├── LoginPage.jsx
        ├── api.js               Every backend API call, one function each
        ├── theme.js              CSS-in-JS theme, NAV_SECTIONS, shared icons/badges
        ├── security/            apiClient.js, tokenManager.js, errorHandler.js, inputValidator.js
        └── components/
            ├── DashboardView.jsx        Stat cards + ITC-risk insights section + AI insight + anomalies
            ├── DocumentsView.jsx        List + detail modal + manual correction + audit trail
            ├── ROICalculatorView.jsx    ROI calculator form + results
            ├── AuditLogView.jsx         Tenant-wide audit trail
            ├── GSTSyncView.jsx, TaxBankView.jsx, ReconciliationRulesView.jsx,
            ├── TeamView.jsx, NotificationsView.jsx, IntegrationsView.jsx,
            ├── ProfileView.jsx, SecurityView.jsx, BillingView.jsx, AdminPanelView.jsx
```

---

## D. Completed Modules

| Module | Status |
|---|---|
| Auth (register/login/refresh/logout, JWT, bcrypt) | ✅ Complete |
| Google / Apple OAuth login | ✅ Complete |
| Document upload + storage (S3/local dual-mode) | ✅ Complete |
| OCR pipeline (RapidOCR + PyMuPDF for PDFs) | ✅ Complete |
| OCR confidence score | ✅ Complete |
| Reconciliation matching engine (Go, deterministic) | ✅ Complete |
| Reconciliation evidence (`reconciliation_reason`, every outcome) | ✅ Complete |
| Manual correction workflow (`PATCH /documents/{id}/correct`) | ✅ Complete |
| Complete audit trail (append-only, per-field diffs) | ✅ Complete |
| Exception reason for every mismatch | ✅ Complete |
| Downloadable reconciliation report (CSV) | ✅ Complete |
| Duplicate invoice detection | ✅ Complete |
| Missing invoice detection | ✅ Complete (on-demand trigger only — see Known Bugs / Roadmap) |
| ITC-risk daily dashboard (`GET /dashboard/insights`) | ✅ Complete, backend + frontend |
| ROI calculator (`POST /roi-calculator`) | ✅ Complete, backend + frontend (in-app only, no public marketing page yet) |
| GST portal sync | ✅ Complete |
| Bank account / tax identifier management | ✅ Complete |
| Team accounts (invite/revoke) | ✅ Complete |
| Platform admin panel | ✅ Complete |
| Razorpay / Stripe / Slack integrations | ✅ Complete |
| WhatsApp / email document ingest webhooks | ✅ Complete |
| Rate limiting, AI budget guard, field encryption | ✅ Complete |
| Automated test suite (backend or frontend) | ❌ Not started — zero test files exist |
| CI/CD pipeline | ❌ Not started |
| Scheduled triggers (missing-invoice scan, GST sync) | ❌ Not started — both are request-triggered only |
| Per-team-member audit attribution | ❌ Not started — everything attributes to tenant owner |
| QRMP / staggered GSTR-3B filing-deadline support | ❌ Not started — standard monthly-filer calendar only |
| Public marketing site / ROI calculator embed | ⏳ Not in this repo — separate site per project history, not started here |
| Sentry integration | ⏳ In progress — config field exists, no actual Sentry client call wired up |

---

## E. Current Task (exact state when this handover was written)

The immediately preceding thread of work was, in order:
1. Verified the OCR/Tesseract-on-AL2023 fix already in the codebase
   (RapidOCR Lambda, no `dnf` install) — confirmed correct, no changes
   needed.
2. Built the ITC-risk daily dashboard (`GET /dashboard/insights`) and
   the ROI calculator (`POST /roi-calculator`) — backend, then a
   Textract-based PDF/OCR fallback was **started**, then **explicitly
   reverted** per a direct instruction to avoid paid cloud services —
   replaced with PyMuPDF-based PDF rasterization inside the existing
   OCR Lambda (free/open-source, no new AWS service).
3. Built the full frontend for all of the above: dashboard insights
   section, the Documents Matrix detail/correction/audit-trail modal,
   a new ROI Calculator tab, and a new tenant-wide Audit Trail tab.
   Verified with a real `npm install` + `CI=true npm run build`
   (compiled successfully).
4. **This document and the rest of `docs/`** were the last thing
   produced — a full engineering handover package, requested
   explicitly so a different engineer (or a future session with no
   access to this conversation) can continue without re-deriving any
   of the above from scratch.

**There is no half-finished code change at the moment this handover was
written.** Every module listed "✅ Complete" in section D was verified
via `go build ./...`, `go vet ./...`, `gofmt -l .` (backend) and
`CI=true npm run build` (frontend) immediately before this handover was
assembled. The next work session should start from `docs/ROADMAP.md` /
section H below, not from finishing anything left mid-edit.

---

## F. Known Bugs

**None currently open that are actual bugs** (as opposed to
not-yet-built features — see section D's ❌ rows, which are scope gaps,
not bugs). One real bug **was found and fixed** during this handover
period, worth knowing about because it may have left artifacts (e.g.
existing `DocumentItem`s in a real deployed table with empty fields
from before the fix):

- **Fixed**: PDF documents were previously OCR'd as "unavailable" with
  no rasterization step at all — every field stayed empty, silently.
  If you're operating a deployment that predates this handover, any
  document with `processing_status=PARSED` and every extracted field
  empty is likely a victim of this bug and may be worth re-queuing
  through OCR now that PyMuPDF rasterization is in place.

If you find a genuine bug while working, add it here with enough
detail (symptom, suspected cause, file) that the next person doesn't
have to re-diagnose it from scratch.

---

## G. Coding Standards

Full detail: `docs/CONTRIBUTING.md`. The two things most worth
internalizing before making a change:

1. **No test suite exists.** Every correctness claim in this codebase
   today rests on `go build`/`go vet`/`gofmt` + manual verification.
   Treat that as a real gap, not a settled decision — adding tests
   around whatever you touch is high-leverage precisely because
   there's no safety net yet.
2. **Comments explain *why*, not *what*.** This is how `docs/DECISIONS.md`
   and `docs/SYSTEM_DESIGN.md` were written accurately — by reading the
   comments already in the code. Keep writing that kind of comment.

Backend: one file per entity (`internal/repository/`), one file per
resource area (`internal/httpapi/`), all DynamoDB keys built via
`internal/db/dynamodb.go` functions (never inline). Always verify
`gofmt -l .` is empty, `go vet ./...` is clean, `go build ./...`
succeeds, and both Lambda targets
(`GOOS=linux GOARCH=amd64 go build ./cmd/api` / `./cmd/worker`) compile
before considering backend work done.

Frontend: plain CRA, no CSS framework, inline styles using
`src/theme.js`'s CSS variables, one component per file, all API calls
through `src/api.js`. Always verify `CI=true npm run build` completes
with "Compiled successfully" before considering frontend work done —
`CI=true` matters, it's what makes ESLint warnings build-failing, same
as a real pipeline would.

**Cost-sensitive changes need explicit product sign-off** — see
`docs/DECISIONS.md` #3 for why this is called out specifically: a paid
cloud OCR fallback was built once and had to be reverted.

---

## H. Next 10 Tasks

In priority order (see `docs/ROADMAP.md` for the same list with more
context):

1. Add an EventBridge scheduled trigger for
   `POST /reconciliation/detect-missing-invoices` (currently on-demand
   only) — fan out across active tenants daily.
2. Add an EventBridge scheduled trigger for `POST /gst/sync` — same
   gap, vendor filing status currently only updates when manually/
   explicitly triggered.
3. Add per-team-member identity through `TenantContext` so audit trail
   entries and manual corrections attribute to the actual logged-in
   team member, not always `tenant.OwnerEmail`.
4. Extend `internal/pipelines/dashboard/insights.go`'s filing-deadline
   calculation to handle QRMP quarterly filers and state-staggered
   GSTR-3B due dates (currently standard monthly-filer calendar only).
5. Stand up a CI/CD pipeline (build + `go vet`/`gofmt` + frontend
   `CI=true npm run build` as a merge gate, then automate the
   `DEPLOYMENT.md` steps).
6. Write the first real tests — start with
   `internal/pipelines/reconciliation` (pure functions, no AWS
   dependency, highest-value place to start since it's the core
   money-matching logic) and `internal/pipelines/dashboard`.
7. Wire `SENTRY_DSN` into `internal/logging` for real (config field
   exists, no actual Sentry client call is made yet).
8. Add Meta's `X-Hub-Signature-256` HMAC verification to the WhatsApp
   webhook (`internal/httpapi/webhook_handlers.go`) — currently only
   the verify-token handshake is checked, inbound POSTs aren't
   signature-verified.
9. Decide where the ROI calculator's public marketing-site presence
   lives (separate repo per project history, or a new one) and build
   that page against the already-public `POST /roi-calculator`
   endpoint — no backend change needed, this is a frontend/marketing
   task.
10. Document and/or automate a secret-rotation runbook for
    `JWT_SECRET_KEY`, `APP_SECRET_KEY`, and especially
    `FIELD_ENCRYPTION_KEY` (rotating the latter without a
    re-encryption migration pass will permanently break decryption of
    existing bank account numbers — see `docs/SECURITY.md`).
