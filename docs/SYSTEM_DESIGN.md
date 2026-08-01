# System Design

This doc covers the *why* behind the structural choices in
`ARCHITECTURE.md` — the tradeoffs a new engineer would otherwise have
to reverse-engineer from code comments scattered across the repo.

## Single DynamoDB table, not one table per entity

DynamoDB's always-free tier (25 GB storage, 25 RCU, 25 WCU) is an
**account-wide** budget shared across every table and every GSI in the
account — it is not "25 free RCU per table." One table with 3 GSIs = 4
capacity groups. Splitting the ~10 entity types in this app
(tenant, document, bank transaction, tax identifier, bank account, team
member, anomaly, audit log, 3× settings) across separate tables would
multiply that far past the free budget. See `DATABASE_SCHEMA.md` for
the full key design this produces.

**Tradeoff accepted**: several list operations (documents by tenant,
audit log by tenant, GST-status filtering) do a bounded Query then
filter/sort in Go rather than using a purpose-built index, because a
4th+ GSI wasn't worth the capacity cost at this app's expected
document volume (an SMB's monthly invoice count, not enterprise scale).
This is called out at each call site in `internal/repository/*.go` —
search for "bounded scan" or "same reasoning" in those files if you're
deciding whether to add a new GSI.

## Go rewrite of a Python/FastAPI + Celery original

The codebase was originally Python (FastAPI + Celery + PostgreSQL) and
was rewritten to Go on DynamoDB. Reasons (see `DECISIONS.md` for the
full record): Lambda cold-start performance, single static binary
deployment (no dependency-hell Docker layers), and — the concrete
trigger — Tesseract's system-package install (`dnf install tesseract`)
repeatedly failing / taking 30+ minutes to build on the AL2023 Lambda
base image.

**What ported 1:1**: reconciliation matching math (Levenshtein +
weighted scoring), GST sync logic, security posture (bcrypt, JWT claims
shape, AES-256-GCM field encryption — stronger than the original
Fernet, not cross-compatible, see the migration note in the old
README), rate limiting behavior.

**What changed**: PostgreSQL → DynamoDB (relational → single-table
NoSQL, the biggest structural change), Tesseract/pdftoppm `os/exec` →
a separate RapidOCR Python Lambda (see `ARCHITECTURE.md`'s AI/OCR
section), rapidfuzz → hand-implemented Levenshtein (verified against
the same formula), FastAPI dependency injection → a single
`RequireAuth` middleware + `TenantContext`.

## Why a separate Python Lambda for OCR (not pure Go, not a cloud API)

Three options were on the table for OCR, evaluated explicitly:

1. **Port RapidOCR's detection/recognition pipeline to Go from
   scratch** — rejected. No AI assistant working on this without the
   ability to run real invoice images through the result and visually
   verify correctness should hand-port a DBNet+CRNN pipeline; a wrong
   normalization constant would silently produce garbage
   amounts/dates with no error signal, in a financial application.
2. **Cloud OCR API (AWS Textract, Google Document AI)** — rejected,
   explicitly, on cost grounds: these are paid per-page/per-document
   APIs, and "no cloud-dependent service that costs money" was a
   direct product requirement. (A Textract integration was partially
   built in an earlier session and then reverted for exactly this
   reason — see `DECISIONS.md`.)
3. **Small, separate, pip-only Python Lambda calling the real
   `rapidocr-onnxruntime` package** — chosen. No system packages, no
   per-page cost, calls tested/maintained OCR code rather than
   reimplementing it.

PDF support follows the same free/open-source principle: PDFs are
rasterized to images with **PyMuPDF** (pip-installable, no
poppler/ghostscript system packages) inside the same OCR Lambda,
rather than sending PDFs to a paid cloud API that natively accepts
them.

## Why reconciliation matching is deterministic Go, not an LLM call

Reconciliation (matching an invoice to a bank transaction) runs at
every document upload and could run at meaningful volume per tenant.
An LLM call per match would be both slower and put OCR-pipeline cost at
the mercy of invoice volume. Instead it's pure arithmetic — weighted
Levenshtein-similarity on vendor name/narration, amount match, date
proximity — deterministic, free to run at any volume, and its output
(`Reason`/evidence string) is auditable in a way "the LLM said so"
isn't. The Anthropic API is used exactly once per dashboard load, for
one plain-English paragraph — not in the money-matching path.

## Why manual corrections re-queue reconciliation instead of directly
## recomputing it inline

`HandleCorrectDocument` (`internal/httpapi/document_handlers.go`)
re-enqueues a reconciliation task via SQS rather than calling the
reconciliation pipeline synchronously in the HTTP handler. This keeps
the API request fast (correction save + audit log write, no bank-data
scan in the request path) and keeps "OCR/reconciliation always happens
in the worker, HTTP handlers only ever enqueue or read" as a single
consistent rule across the codebase — there's exactly one place
(`cmd/worker/main.go`) that ever runs reconciliation, so its behavior
can't drift between an inline path and a queued path.

## Why the audit log is a separate item type, not a field history on
## the document

An `AuditLogItem` (see `DATABASE_SCHEMA.md`) is written once per
change and never updated or deleted — there is deliberately no
`Update`/`Delete` method on `AuditLogsRepo`. Storing "history" as a
mutable list field on the `DocumentItem` instead would make it
possible (even if unintentionally) to edit or truncate history when
editing the document. Append-only, separate items is the only shape
that can't accidentally stop being an audit trail.

## Why the ROI calculator is a stateless, unauthenticated endpoint

`POST /api/v1/roi-calculator` takes no tenant context, persists
nothing, and requires no auth — on purpose, so the exact same call
works from the logged-in dashboard today and from a public marketing
page later without any backend change. The two modeling assumptions
(ITC leakage rate, time-saved rate) are overridable inputs, always
echoed back in the response — this was a deliberate choice to avoid
presenting a marketing estimate as a verified guarantee.
