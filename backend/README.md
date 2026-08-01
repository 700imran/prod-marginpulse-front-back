# MarginPulse Pro — Backend (Go)

Complete rewrite of `01-backend-api` (FastAPI/Python) + `03-lambda-workers`
(Python) into Go, on DynamoDB. Feature parity with the Python version —
every endpoint, every background task, same security posture (bcrypt,
JWT, AES-256-GCM field encryption, rate limiting, AI budget guard).

## Structure

```
cmd/
  api/          Lambda entry point (API Gateway HTTP API) — replaces main.py
  worker/       Lambda entry point (SQS-triggered) — replaces lambda_handler.py
  localserver/  Plain net/http server for local dev (no AWS needed)
internal/
  config/       Env-var settings (ported from app/core/config.py)
  security/     bcrypt, JWT, AES-256-GCM field encryption, token blocklist
  ratelimit/    Redis-backed rate limiting (ported from slowapi usage)
  aibudget/     Per-tenant AI/LLM cost guard
  db/           DynamoDB client + key builders (single source of truth)
  repository/   One file per entity — all DynamoDB reads/writes
  queue/        SQS task dispatch (ported from queue_service.py)
  storage/      S3/R2 + local filesystem dual-mode storage
  email/        SMTP sending (stdlib net/smtp)
  logging/      Structured JSON logging (stdlib log/slog)
  pipelines/    OCR, reconciliation matching, GST sync, identity verification, insights
  httpapi/      HTTP handlers, middleware, router (Go 1.22 net/http.ServeMux)
infra/
  dynamodb-table.yaml   The single DynamoDB table + 3 GSIs (deploy first)
DYNAMODB_SCHEMA.md       Full key-design reference
```

## What changed vs. the Python version (and what didn't)

| | Python | Go |
|---|---|---|
| Database | PostgreSQL (Neon) | DynamoDB (single-table, see DYNAMODB_SCHEMA.md) |
| Web framework | FastAPI + Mangum | stdlib `net/http` (Go 1.22 pattern routing) + hand-written API Gateway adapter |
| Password hashing | bcrypt (passlib) | bcrypt (`golang.org/x/crypto/bcrypt`) — same algorithm |
| JWT | python-jose | `golang-jwt/jwt/v5` — same claims shape |
| Field encryption | Fernet (AES-128-CBC+HMAC) | AES-256-GCM (stdlib `crypto/aes`) — stronger, but **not** cross-compatible; see migration note below |
| Rate limiting | slowapi + Redis | hand-rolled fixed-window counter + Redis — same behavior |
| Structured logging | structlog | stdlib `log/slog` — zero dependency needed |
| OCR | pytesseract/pdf2image (Python wrappers) | Direct `os/exec` calls to the same `tesseract`/`pdftoppm` binaries — identical OCR engine |
| Fuzzy matching | rapidfuzz | Hand-implemented Levenshtein (stdlib only) — verified matching scores against the Python formula |
| Anthropic API | official Python SDK | hand-written REST client (`net/http`) — no official Go SDK exists |
| Reconciliation math, GST sync logic, insights rules | — | Ported line-for-line, same formulas/thresholds |

**Migration note**: bank account numbers encrypted under the Python
version's Fernet key are NOT decryptable by this Go version's AES-GCM —
this is a one-time data migration (decrypt with old code, re-encrypt
with new) if you're moving an existing production database, not an
ongoing compatibility concern for a fresh deployment.

## Build & run locally

```bash
go build ./...              # verify everything compiles
go run ./cmd/localserver     # http://localhost:8000, no AWS needed
```

Local dev needs DynamoDB Local + Redis running and `.env` populated —
same variable names as the Python version's `.env.example`, plus
`DYNAMODB_TABLE_NAME`/`DYNAMODB_ENDPOINT_URL` instead of `DATABASE_URL`.

## Deploy

1. `aws cloudformation deploy --template-file infra/dynamodb-table.yaml --stack-name marginpulse-dynamodb`
2. Build + push both Lambda images (`cmd/api/Dockerfile`, `cmd/worker/Dockerfile`) to ECR
3. Deploy Lambda functions + API Gateway + SQS — same overall shape as
   the Python version's `infra/api-template.yaml` /
   `03-lambda-workers/infra/template.yaml`, just pointing `ImageUri` at
   these new Go images and setting `DYNAMODB_TABLE_NAME` instead of
   `DATABASE_URL`/`DATABASE_URL_SYNC`.

See `SETUP_GUIDE.md` / `DEPLOYMENT.md` from the Python delivery for the
full account-setup and rollback runbook — identical process, only the
container images and one env var (`DYNAMODB_TABLE_NAME` replacing
`DATABASE_URL`) change.

## Verified state

`go build ./...`, `go vet ./...`, and `gofmt -l .` all pass clean as of
this delivery — every package listed above actually compiles against
real AWS SDK for Go v2, `golang-jwt`, `go-redis`, `sentry-go`, and
`aws-lambda-go`, not just written-but-untested code.

## Auth & integrations (added after the initial Go rewrite)

**Fully implemented, calls real provider APIs:**
- `internal/oauth/google.go` — Sign in with Google (OAuth2 authorization code flow)
- `internal/oauth/apple.go` — Sign in with Apple (ES256 client-secret JWT + JWKS-verified id_token)
- `internal/integrations/razorpay.go` — Razorpay Settlements API (API-key auth)
- `internal/integrations/stripe.go` — Stripe Payouts API (API-key auth)
- `internal/integrations/slack.go` — Slack OAuth + incoming-webhook alerts
- `internal/repository/integrations.go` — encrypted per-tenant credential storage (same AES-256-GCM as bank account numbers)

**NOT implemented — see `internal/integrations/stub.go` for exactly
what each needs** (a real developer account per provider, and for
SAP/NetSuite a vendor partnership — not just more code):
PayPal, Square, Notion, QuickBooks Online, Xero, Tally, HubSpot, Salesforce, SAP, NetSuite.

New env vars for the above: see the OAuth/Slack sections of `.env.example`.


## OCR architecture (revised)

Originally this ran `tesseract`/`poppler-utils` installed via `dnf` on
top of `public.ecr.aws/lambda/provided:al2023` (the minimal Lambda
container base). In practice, installing OS packages onto that base
image proved unreliable — installs stalling 30+ minutes then failing,
a real/reproducible pain point, not a one-off fluke.

**Current architecture**: `ocr-service/` is a small, separate Python
Lambda running the real, maintained `rapidocr-onnxruntime` package
(pip install only — no system package manager involved at all, which is
what makes this reliable). The Go worker (`cmd/worker`) invokes it
synchronously via AWS SDK's `lambda.Invoke` (see
`internal/pipelines/ocr/ocr.go`) and applies the same regex-based
structured-field extraction (vendor/amount/date/GSTIN/invoice number) as
before on the returned text.

**Why not port RapidOCR's detection/recognition pipeline to Go
directly**: RapidOCR has no native Go implementation — using it from Go
would mean either CGO-binding a bundled ONNXRuntime shared library and
reimplementing RapidOCR's pre/post-processing (perspective-corrected
text-box detection, CRNN+CTC decoding) from scratch, unverified against
real images in this environment, or accepting the risk of silently
wrong OCR output with no compile-time signal of the error. Calling the
real Python package from a small Lambda avoids that risk — see the
model's own PyPI page for its accuracy/benchmark claims, which this
repo simply invokes rather than reimplements.

**Known current gap**: `ProcessDocument` currently expects a raster
image (PNG/JPEG) — PDF documents return `OCRAvailable: false` rather
than being silently mishandled. Adding PDF support means adding a
rasterization step (first page → image) before the Lambda invoke;
tracked as a follow-up, deliberately not solved by reintroducing
poppler-utils/dnf on the Go worker's image (the exact problem this
whole redesign avoids). A pure-Go PDF rasterizer, or asking Textract
for that one step, are both viable next choices when this is picked up.
