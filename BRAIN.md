# BRAIN.md — Engineering Handover

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
