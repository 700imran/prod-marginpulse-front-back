# Architecture

## High-level shape

```
Browser (React SPA)
      │  HTTPS / JSON (JWT bearer)
      ▼
API Lambda (Go, cmd/api) ──────────────► DynamoDB (single table, 3 GSIs)
      │  enqueue task                          ▲
      ▼                                         │
   SQS queues (5)                               │
      │                                         │
      ▼                                         │
Worker Lambda (Go, cmd/worker) ─────────────────┘
      │  invoke (sync)
      ▼
OCR Lambda (Python, ocr-service) — RapidOCR + PyMuPDF
```

Everything is Go except one small, deliberately-isolated Python Lambda
for OCR (see "AI/OCR pipeline" below for why).

## Frontend

- Plain **Create React App** (react-scripts 5, React 18) — not Next.js.
  No CSS framework; a single hand-written CSS-in-JS theme
  (`src/theme.js`, "neomorphism" look: soft shadows, rounded cards) is
  injected once via a `<style>` tag in `App.jsx`.
- No client-side router — navigation is a `useState` string
  (`activeNav`) switched in `App.jsx`'s `renderContent()`; each nav
  item is a component in `src/components/`.
- All API calls go through `src/api.js` — a single fetch wrapper with:
  JWT bearer auth from `localStorage`, automatic refresh-token retry on
  401, and one function per backend endpoint.
- Deploys as a **standalone static site** (e.g. Cloudflare Pages,
  Vercel) with `REACT_APP_API_URL` baked in at build time (CRA env-var
  behavior — changing it requires a rebuild, not just a redeploy).
- No server-side rendering, no API routes living in the frontend repo —
  100% of business logic is in the Go backend.

## Backend

- **Go 1.22**, using the stdlib `net/http.ServeMux`'s pattern routing
  (`GET /api/v1/documents/{id}`) — no external router dependency
  (no gin/chi/mux).
- Two Lambda entry points sharing all the same `internal/` packages:
  - `cmd/api` — HTTP API, fronted by API Gateway (HTTP API, not REST
    API) in production; `cmd/localserver` runs the identical handlers
    on plain `net/http` for local dev with no AWS needed.
  - `cmd/worker` — SQS-triggered background task processor (OCR,
    reconciliation, GST sync, tax-identifier verification, bank-account
    verification).
- This is a from-scratch **Go port of an earlier FastAPI/Python +
  Celery/PostgreSQL codebase** — see `DECISIONS.md` for why the
  migration happened and what changed vs. stayed the same.

## Database

- **DynamoDB**, single table (`marginpulse-<env>`), 3 GSIs — chosen
  specifically to fit AWS's always-free tier (25 GB storage, 25
  RCU/WCU, forever) as one account-wide budget. See
  `DATABASE_SCHEMA.md` for the full key-design reference.
- No relational database, no ORM. `internal/repository/*.go` — one
  file per entity — is the only code that touches DynamoDB directly.

## Queues

- **5 SQS queues**, one per background task type: OCR pipeline,
  reconciliation, GST sync, tax-identifier verification, bank-account
  verification. `internal/queue/queue.go` publishes; `cmd/worker/main.go`
  dispatches by task name to the matching handler function.
- Task payloads are plain JSON maps (`map[string]interface{}`) — see
  `internal/queue/queue.go`'s `Enqueue*` functions for the exact shape
  each task expects.

## Authentication

- **JWT** (access + refresh token pair), `golang-jwt/jwt/v5`.
  - Access token: short-lived (`JWT_ACCESS_TOKEN_EXPIRE_MINUTES`,
    default 60 min).
  - Refresh token: long-lived (`JWT_REFRESH_TOKEN_EXPIRE_DAYS`, default
    30 days), revocable via a Redis-backed token blocklist
    (`internal/security/tokenblocklist.go`) — logout adds the token's
    `jti` to the blocklist rather than relying on natural expiry.
- **Password auth**: bcrypt (`golang.org/x/crypto/bcrypt`).
- **OAuth login**: Google and Apple Sign In, both with Redis-backed
  CSRF state tokens (`internal/oauth/state.go`) — the OAuth callback
  redirects to the frontend with tokens in the URL **fragment** (never
  sent to any server/logged by a CDN) — see `App.jsx`'s
  `consumeOAuthCallbackIfPresent()`.
- **Multi-tenant**: every request resolves to exactly one `TenantItem`
  via `RequireAuth` middleware (`internal/httpapi/middleware.go`),
  attached to the request context as `TenantContext`. There is
  currently **no separate per-user identity below the tenant level** —
  team members (`internal/repository/teammembers.go`) exist as
  invited/role-tagged records, but actions (manual corrections, anomaly
  resolutions) are attributed to `tenant.OwnerEmail`, not to the
  specific team member who's logged in. See `TROUBLESHOOTING.md`.
- **Field encryption**: bank account numbers are encrypted at rest with
  AES-256-GCM (`internal/security/fieldencryption.go`) — a separate
  `FIELD_ENCRYPTION_KEY`, independent of the password/JWT auth secrets.

## AI / OCR pipeline

**No cloud-cost OCR dependency, by design** (this was an explicit
product decision — see `DECISIONS.md`):

```
Go Worker (cmd/worker)
    │  download bytes from storage
    ▼
internal/pipelines/ocr/ocr.go
    │  AWS Lambda Invoke (sync), passing {file_base64, mime_type}
    ▼
ocr-service/ (separate small Python Lambda)
    │  if mime_type contains "pdf": rasterize pages with PyMuPDF
    │  (pip-only, free/open-source, no system packages)
    │  run rapidocr-onnxruntime on each page image
    ▼
returns {lines: [{text, confidence}, ...]}
    │
    ▼ (back in ocr.go)
regex-based structured extraction: vendor name, amount, tax amount,
GSTIN, invoice number, date
```

Why a separate Python Lambda instead of a pure-Go OCR implementation:
RapidOCR has no native Go port, and hand-porting its detection/
recognition pipeline without the ability to visually verify output
against real invoices would produce code that compiles but has no
verified correctness in a financial application. Calling the real,
maintained Python package avoids that risk.

Why RapidOCR (not PaddleOCR/Surya/Textract): pip-installable, no
system packages (`dnf`/`apt`) needed on the AL2023 Lambda base image —
this is the direct fix for the original problem (Tesseract's system
package install took 30+ minutes and ultimately failed on AL2023).
PaddleOCR has historically had similar system-level dependency issues;
Surya's PyTorch-based wheels are far larger/slower to cold-start.
Textract was evaluated and explicitly rejected — see `DECISIONS.md` —
because it's a paid per-page cloud API and the product requirement was
"no cloud-dependent service that costs money."

**Anthropic API** (`internal/pipelines/insights/insights.go`) is used
separately, for one thing only: turning the dashboard summary numbers
into a one-paragraph plain-English insight
(`plain_english_insight` field). It is NOT part of the OCR or
reconciliation pipeline — reconciliation matching is pure Go
arithmetic (Levenshtein + weighted scoring), not LLM-based, so it's
deterministic and free to run at any volume. `internal/aibudget/` caps
per-tenant token usage so this one LLM call can't run away in cost.

## Deployment

- **Backend**: two Lambda functions (`cmd/api`, `cmd/worker`) + one
  small OCR Lambda (`ocr-service`), deployed via the CloudFormation/SAM
  templates in `infra/` (`api-template.yaml`, `worker-template.yaml`,
  `dynamodb-table.yaml`). See `DEPLOYMENT.md` for the full walkthrough.
- **Frontend**: static build (`npm run build`), deployed to any static
  host (Cloudflare Pages, Vercel, S3+CloudFront) — no server component.
- **Local dev**: `go run ./cmd/localserver` (backend, no AWS needed —
  talks to DynamoDB Local via `DYNAMODB_ENDPOINT_URL`) +
  `npm start` (frontend). See `LOCAL_SETUP.md`.
