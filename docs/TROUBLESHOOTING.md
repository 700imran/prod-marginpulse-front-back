# Troubleshooting

## Build / tooling

**"go: command not found" in a fresh container/sandbox.** Go is not
always preinstalled. On Debian/Ubuntu:
```bash
apt-get install -y golang-1.22-go
export PATH=$PATH:/usr/lib/go-1.22/bin
```

**`go build` / `go mod tidy` fails trying to reach `proxy.golang.org`.**
Some sandboxed environments only allowlist `github.com`/
`codeload.github.com`, not the module proxy. Use direct-from-VCS mode:
```bash
export GOPROXY=direct
export GOSUMDB=off
go mod tidy
```
This fetches real modules straight from GitHub instead of the proxy.

**`go.mod` has `replace` directives pointing at local paths that don't
exist** (e.g. `/home/.../aws-sdk-src/...`). This can happen if a
previous session vendored the AWS SDK locally and those directives got
carried into a committed `go.mod`. Fix: remove the local-path `replace`
lines (keep the legitimate `golang.org/x/*` → `github.com/golang/*`
mirror replacements), then `go mod tidy` with the `GOPROXY=direct`
settings above.

**Docker build fails / times out on Tesseract-related lines.** This
should no longer happen — Tesseract was removed entirely (see
`DECISIONS.md`). If you see `dnf install tesseract` or similar in
`cmd/worker/Dockerfile`, something has regressed; the correct
Dockerfile has no system-package install step at all, just a static Go
binary build.

**`docker build` without `-f` doesn't pick up the right Dockerfile.**
Always specify explicitly:
```bash
docker build -f cmd/api/Dockerfile -t marginpulse-api .
docker build -f cmd/worker/Dockerfile -t marginpulse-worker .
docker build -f ocr-service/Dockerfile -t marginpulse-ocr-service .
```

**Frontend build fails on an eslint rule that "was not found."** CRA's
bundled eslint config doesn't have every plugin rule (e.g.
`react-hooks/exhaustive-deps` isn't registered in this project's
config) — an `// eslint-disable-line react-hooks/exhaustive-deps`
comment referencing an unregistered rule fails the build (CRA treats
this as an error, not a warning). Just don't add disable comments for
rules that aren't part of this project's actual eslint config; if a
hook dependency warning is unavoidable, restructure the effect instead.

## Runtime

**A PDF document is stuck at `PARSED` with every field empty.** This
was a real bug in an earlier state of this code — PDFs were silently
marked "OCR unavailable" with no rasterization step. Fixed: PDFs are
now rasterized with PyMuPDF inside `ocr-service/handler.py` before
RapidOCR runs. If you see this symptom again, check
`ocr-service/requirements.txt` actually has `pymupdf` and that
`mime_type` is being passed correctly from `ocr.go`'s
`invokeOCRLambda`.

**Manual correction doesn't seem to re-run reconciliation.** By
design, only vendor_name/raw_total_amount/document_date changes
trigger a re-queue (`HandleCorrectDocument` in
`document_handlers.go`) — correcting tax_amount, invoice_number, or
tax_identifier alone does not, since those don't feed the matching
score. If a correction to one of those three fields should also
re-trigger reconciliation in your judgment, that's a one-line change
to the `reconciliationRelevant` check.

**Missing-invoice scan finds nothing even though there's an obvious
gap.** See `OPERATIONS.md`'s runbook for this — almost always the
vendor-name-to-narration fuzzy match threshold, not a bug.

**Audit trail shows every correction as made "by" the tenant owner,
even when a different team member was logged in.** This is a known
limitation, not a bug — see `SECURITY.md`'s "known gaps." There's
currently no per-team-member identity threaded through
`TenantContext`; every action attributes to `tenant.OwnerEmail`.

**Local dev: uploaded documents never get OCR'd/reconciled.**
`cmd/localserver` only runs the HTTP API — there's no local SQS
consumer wired up by default. See `LOCAL_SETUP.md`'s note on this; the
task functions in `cmd/worker/main.go` need to either consume from a
real AWS SQS queue (pointed at from your local `.env`) or be invoked
directly while developing.

## Known limitations (not bugs, just not built yet)

- Filing-deadline calculation (`internal/pipelines/dashboard/insights.go`)
  assumes the standard monthly-filer calendar (GSTR-1 by the 11th,
  GSTR-3B by the 20th) — doesn't yet account for QRMP quarterly filers
  or the state-staggered 22nd/24th GSTR-3B due dates some states use.
- Missing-invoice detection is on-demand only (`POST
  /reconciliation/detect-missing-invoices`) — no scheduled trigger.
- No CI/CD pipeline in this repo.
- ROI calculator has no frontend presence outside the logged-in app
  (no public marketing-site component yet, though the endpoint is
  ready for one).
