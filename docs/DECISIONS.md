# Decisions

Chronological log of the significant technical/product decisions made
on this project, with the reasoning — so a new engineer doesn't have
to guess "was this intentional?" before changing something.

## 1. Python/FastAPI/Celery/PostgreSQL → Go/DynamoDB/SQS/Lambda

**Decision**: full rewrite from the original stack to Go on AWS
Lambda + DynamoDB.

**Why**: Lambda cold-start performance and deployment simplicity
(single static binary vs. a Python dependency tree), and — the
concrete trigger — Tesseract's system package install
(`dnf install tesseract`) repeatedly failing / taking 30+ minutes on
the AL2023 Lambda base image, blocking Docker builds outright.

**What ported 1:1 vs. changed**: see `SYSTEM_DESIGN.md`.

## 2. Single DynamoDB table + 3 GSIs, not one table per entity

**Why**: DynamoDB's always-free tier (25 RCU/WCU, 25GB) is an
account-wide budget, not per-table. See `DATABASE_SCHEMA.md`.

## 3. OCR: RapidOCR (Python Lambda), not Tesseract, not PaddleOCR/Surya,
## not a cloud API

**The original ask** (product roadmap) proposed:
```
Go Worker → PDF Rendering Library → PaddleOCR/Surya OCR Service → AWS Textract (optional fallback)
```

**What actually shipped, and why it differs**:
- **RapidOCR instead of PaddleOCR/Surya** as the primary engine. All
  three were evaluated for AL2023 Lambda compatibility. PaddleOCR's
  CPU wheel has historically needed system shared libs
  (`libgomp1`, etc.) not always present on a minimal base image — the
  closest thing to repeating the original Tesseract problem. Surya's
  PyTorch-based wheels install more reliably but are far
  larger/slower to cold-start. RapidOCR (`rapidocr-onnxruntime`) is
  pip-only with no system package dependency at all — the safest
  choice on AL2023, and it was already working, so the primary engine
  was kept rather than swapped for a marginal accuracy gain at real
  reliability risk. **This was a deliberate, explicit choice, not an
  oversight** — confirmed with the product owner mid-project rather
  than assumed.
- **AWS Textract was explicitly rejected**, twice. First implicitly
  (never built). Then a Textract fallback integration was **actually
  built** in one session (Textract client, PDF routing, low-confidence
  fallback) and then **explicitly reverted** in the next, because
  Textract is a paid per-page cloud API and "don't rely on any
  cloud-dependent service that costs money — use an open-source free
  alternative" was a direct, explicit product requirement. If you're
  reading this and considering re-adding Textract (or any other paid
  OCR API) as a fallback, that requirement should be re-confirmed with
  the product owner first, not assumed to have lapsed.
- **PDF rendering**: instead of a separate "PDF Rendering Library" step
  in Go (there's no mature, free, system-dependency-free Go library for
  this — the realistic options were cgo bindings to MuPDF/pdfium,
  which reintroduce system-dependency risk, or shelling out to
  poppler-utils, which is exactly the Tesseract problem again), PDF
  rasterization happens inside the same Python OCR Lambda using
  **PyMuPDF** (`pymupdf`, AGPL-3.0, pip-only, no system packages) —
  same reliability property, one Lambda instead of two.

**Real bug found and fixed along the way**: while building the (later
reverted) Textract path, it became clear that PDF uploads were
previously **silently marked "OCR unavailable"** with no rasterization
step at all — meaning most real invoices (which are PDFs) never got
OCR'd. This wasn't explicitly flagged in the original roadmap; it
surfaced as a side effect of implementing the PDF-handling
architecture the roadmap asked for. Fixed as part of the same PyMuPDF
change.

## 4. Reconciliation matching is deterministic Go, not LLM-based

See `SYSTEM_DESIGN.md`. The Anthropic API is used for exactly one
thing (the dashboard's plain-English insight paragraph), kept
deliberately out of the money-matching path for cost, speed, and
auditability reasons.

## 5. Manual correction re-queues reconciliation via SQS, not inline

See `SYSTEM_DESIGN.md` — keeps "reconciliation only ever runs in the
worker" as a single, unbroken rule.

## 6. Audit log is a separate, append-only item type

No `Update`/`Delete` method exists on `AuditLogsRepo`, on purpose. See
`SYSTEM_DESIGN.md`.

## 7. ROI calculator is public, stateless, and echoes its assumptions

`POST /roi-calculator` requires no auth and persists nothing, so it
works identically from the in-app dashboard and (later) a public
marketing page. The two modeling assumptions (ITC leakage rate, time
saved rate) are always echoed back in the response with an explicit
"these are editable assumptions, not guarantees" note — a deliberate
choice to avoid a marketing estimate being read as a verified claim.

## 8. Product positioning: "Financial Risk Intelligence Platform," not
## "reconciliation tool"

Explicit product direction: the platform should be perceived as
decision intelligence for finance teams / an "operating system for
financial risk and tax decisions," not another reconciliation tool.
Concretely, this is why `GET /dashboard/insights` exists as a separate,
prioritized "what to act on today" view (highest ITC risk, vendors to
follow up, filing deadlines, recoverable ITC) rather than folding those
numbers into the existing mismatch-count `dashboard-summary` endpoint —
the two are kept as separate reads so the daily-action view can evolve
independently of the raw stats view. See `BUSINESS_OVERVIEW.md` for the
full positioning language.
