# Operations

## Monitoring

- **Structured logging**: `internal/logging/logging.go`, stdlib
  `log/slog`, JSON output — one line per request
  (`RequestIDMiddleware` in `internal/httpapi/middleware.go`) with
  `method`, `path`, `status_code`, `duration_ms`, `client_ip`, plus a
  request ID (`X-Request-ID` header, generated if not supplied)
  threaded through every log line in that request's lifecycle.
- **CloudWatch alarms** (from the SAM templates):
  - API Lambda: error-rate alarm → SNS topic → email
    (`AlarmNotificationEmail` parameter).
  - Each of the 5 SQS queues: dead-letter-queue depth / oldest-message
    age alarms.
  - DynamoDB table + each GSI: `ReadThrottleEvents`/
    `WriteThrottleEvents` alarms — this is your early warning that a
    tenant (or overall growth) is approaching the free-tier capacity
    ceiling (see `DATABASE_SCHEMA.md`) before it becomes visible to
    users as throttled requests.
- **Sentry**: `SENTRY_DSN` env var — wire this in if/when Sentry
  integration is added to `internal/logging` (not yet implemented as
  of this handover; the config field exists, the actual Sentry client
  call doesn't — see `ROADMAP.md`).

## Runbooks

### A tenant's dashboard is showing stale/wrong ITC risk numbers

1. Check `GET /reconciliation/dashboard-summary` vs `GET /dashboard/insights`
   — the former reads `summary_metrics` computed differently from the
   latter's GST-status-based reads. If they disagree, the discrepancy
   is almost always a `gst_portal_status` sync issue — check when
   `POST /gst/sync` last ran successfully for that tenant.
2. Check CloudWatch logs for the `run_reconciliation` worker Lambda for
   that tenant's document IDs — `reconciliation_reason` on the
   document itself (or via `GET /documents/{id}`) will explain exactly
   why a given document landed where it did.

### Missing-invoice scan isn't finding an invoice the tenant expects

`internal/pipelines/exceptions/missing_invoice.go`'s
`vendorNarrationMatchThreshold` (0.55) and `olderThanDays` (5) are the
two levers. A vendor name that doesn't fuzzy-match its bank narration
closely enough (e.g. "Sharma Traders" vs. a narration of just
"NEFT/SHARMA/..." with no "Traders") won't surface. This is a tuning
constant, not a bug — if false negatives are common, lowering the
threshold is the first thing to try, with the tradeoff of more false
positives a human then has to dismiss.

### Redis is down

Rate limiting, token revocation checks, and OAuth CSRF state all depend
on Redis. `internal/ratelimit`'s `getClient()` and
`internal/security/tokenblocklist.go`'s `getBlocklistClient()` will
error on every call if Redis is unreachable — this is currently a hard
dependency, not a soft-fail/bypass. If Redis needs to go down for
maintenance, expect logins, logouts, and rate-limited endpoints to
degrade or fail during the outage.

### A Lambda's cold start is too slow

- API/worker Lambdas: Go binaries, generally fast cold starts already.
- OCR Lambda: the slowest cold start in the system (ONNXRuntime +
  RapidOCR model loading, `_engine = RapidOCR()` at module level in
  `ocr-service/handler.py`, loaded once per cold start). If cold-start
  latency becomes a user-facing problem, provisioned concurrency on
  `OcrServiceFunction` is the first lever, before considering a model
  swap.

## Cost levers

- DynamoDB: stays inside the always-free tier as designed (see
  `DATABASE_SCHEMA.md`) unless per-tenant document volume grows far
  beyond an SMB's expected monthly invoice count.
- OCR: zero per-page cloud cost by design (RapidOCR + PyMuPDF, both
  free/open-source, run inside your own Lambda) — the only OCR-related
  cost is Lambda compute time itself.
- Anthropic API: capped per-tenant by `internal/aibudget` — see
  `SECURITY.md`.
- SQS/Lambda: pay-per-use, scales with actual document volume, no
  fixed floor.
