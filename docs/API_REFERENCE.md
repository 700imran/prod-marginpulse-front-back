# API Reference

Base path: `/api/v1`. All authenticated endpoints expect
`Authorization: Bearer <access_token>`. Source of truth:
`internal/httpapi/router.go` (routes) + one `internal/httpapi/*_handlers.go`
file per resource area — if this doc and the code ever disagree, the
code wins; update this doc in the same PR that changes a route.

Unauthenticated endpoints are marked **(public)**.

## Health

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness |
| GET | `/health/ready` | Readiness (checks DynamoDB/Redis reachability) |

## Auth

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` **(public)** | `{business_name, email, password, country_code}` |
| POST | `/auth/login` **(public)** | `{email, password}` |
| POST | `/auth/refresh` **(public)** | `{refresh_token}` |
| POST | `/auth/logout` | Revokes both tokens via Redis blocklist |
| GET | `/auth/me` | Current tenant profile |
| PATCH | `/auth/me` | Update profile fields |
| POST | `/auth/change-password` | `{current_password, new_password}` |
| GET | `/auth/google/login` **(public)** | Redirects to Google OAuth |
| GET | `/auth/google/callback` **(public)** | OAuth callback |
| GET | `/auth/apple/login` **(public)** | Redirects to Sign in with Apple |
| POST | `/auth/apple/callback` **(public)** | OAuth callback (Apple posts form data) |

## Documents

| Method | Path | Notes |
|---|---|---|
| POST | `/documents/upload` | Multipart `file` + `doc_type` |
| GET | `/documents` | `?status=&doc_type=` |
| GET | `/documents/{id}` | Single document |
| GET | `/documents/{id}/download-url` | Presigned S3 URL (or local dev URL) |
| GET | `/documents/file/{key...}` | Dev-mode-only local file server |
| PATCH | `/documents/{id}/correct` | Manual correction workflow — see below |
| GET | `/documents/{id}/audit-log` | This document's audit trail |

**`PATCH /documents/{id}/correct` body**:
```json
{
  "vendor_name": "string, optional",
  "document_date": "YYYY-MM-DD, optional",
  "invoice_number": "string, optional",
  "raw_total_amount": "number, optional",
  "tax_amount": "number, optional",
  "tax_identifier": "string, optional",
  "reason": "string, REQUIRED"
}
```
Only fields present in the body are changed. Re-queues reconciliation
if vendor_name/raw_total_amount/document_date changed. Every changed
field writes one audit log entry.

## Audit trail

| Method | Path | Notes |
|---|---|---|
| GET | `/audit-log` | `?entity_type=DOCUMENT\|ANOMALY\|BANKTXN&entity_id=&limit=` — tenant-wide |
| GET | `/documents/{id}/audit-log` | Shortcut for one document's history |

## Dashboard

| Method | Path | Notes |
|---|---|---|
| GET | `/reconciliation/dashboard-summary` | Mismatch-count stats + AI plain-English insight paragraph |
| GET | `/dashboard/insights` | **The daily business dashboard** — highest ITC risk today, vendors requiring follow-up, filing deadlines approaching, estimated recoverable ITC |

## Reconciliation

| Method | Path | Notes |
|---|---|---|
| POST | `/reconciliation/run` | Manually trigger a reconciliation pass |
| POST | `/reconciliation/bank-csv-upload` | Multipart bank statement CSV |
| GET | `/reconciliation/anomalies` | `?status=OPEN\|RESOLVED` |
| POST | `/reconciliation/anomaly/{id}/resolve` | Marks resolved, writes an audit log entry |
| GET | `/reconciliation/export` | Streams a CSV (not JSON) — the downloadable reconciliation report |
| POST | `/reconciliation/detect-missing-invoices` | On-demand missing-invoice scan (see `DATA_FLOW.md`) |

## ROI Calculator

| Method | Path | Notes |
|---|---|---|
| POST | `/roi-calculator` **(public)** | See request/response shape below |

**Request**:
```json
{
  "monthly_invoice_volume": 150,
  "avg_invoice_value_inr": 25000,
  "avg_gst_rate_percent": 18,
  "hours_spent_manually_per_month": 40,
  "hourly_cost_inr": 400,
  "monthly_plan_price_inr": 4999,
  "itc_leakage_rate_percent": 8,
  "time_saved_percent": 70
}
```
The last two are optional overrides for the two modeling assumptions
(defaults: 8% / 70%). Response includes `inputs`, `assumptions_used`
(always echoed, with a "not guarantees" note), `results`
(`monthly_gst_value_inr`, `estimated_monthly_itc_recovered_inr`,
`hours_saved_per_month`, `monthly_time_savings_inr`,
`total_monthly_value_inr`, `net_monthly_roi_inr`, `roi_multiple`), and
a one-line `summary` string.

## Webhooks

| Method | Path | Notes |
|---|---|---|
| GET | `/webhook/whatsapp` **(public)** | Meta webhook verification challenge |
| POST | `/webhook/whatsapp` **(public)** | Inbound WhatsApp document forwarding |
| POST | `/webhook/email-ingest` **(public)** | Inbound email document forwarding (shared secret in body/header, not JWT) |

## GST

| Method | Path | Notes |
|---|---|---|
| POST | `/gst/sync` | Trigger a GSTR-2B comparison sync |
| GET | `/gst/vendor-status` | Per-vendor filing status |
| GET | `/gst/itc-summary` | ITC summary stats |

## Communications

| Method | Path | Notes |
|---|---|---|
| GET | `/comms/generate-reminder` | Generates a vendor-reminder message for a GST issue |

## Tax identifiers (GSTINs)

| Method | Path | Notes |
|---|---|---|
| GET | `/tax-identifiers` | List |
| POST | `/tax-identifiers` | Add `{id_type, id_value, label}` |
| POST | `/tax-identifiers/{id}/reverify` | Re-check GST portal verification status |
| POST | `/tax-identifiers/{id}/set-primary` | |
| DELETE | `/tax-identifiers/{id}` | |

## Bank accounts

| Method | Path | Notes |
|---|---|---|
| GET | `/bank-accounts` | List |
| POST | `/bank-accounts` | Add (account number encrypted at rest, AES-256-GCM) |
| POST | `/bank-accounts/{id}/set-primary` | |
| DELETE | `/bank-accounts/{id}` | |

## Settings

| Method | Path | Notes |
|---|---|---|
| GET / PATCH | `/settings/reconciliation` | Confidence/auto-approve thresholds |
| GET / PATCH | `/settings/notifications` | |
| GET / PATCH | `/settings/integrations` | |

## Team

| Method | Path | Notes |
|---|---|---|
| GET | `/team` | List team members |
| POST | `/team/invite` | `{email, role}` |
| POST | `/team/{id}/revoke` | |

## Integrations

| Method | Path | Notes |
|---|---|---|
| GET | `/integrations` | List connected providers |
| POST | `/integrations/{provider}/connect` | Razorpay/Stripe: tenant pastes their own API keys, encrypted per-tenant |
| POST | `/integrations/{provider}/sync` | |
| POST | `/integrations/{provider}/disconnect` | |
| GET | `/integrations/slack/connect` | Slack OAuth start |
| GET | `/integrations/slack/callback` | Slack OAuth callback |

## Platform admin (requires `is_platform_admin`)

| Method | Path | Notes |
|---|---|---|
| GET / PATCH | `/admin/settings` | Global platform settings |
| GET | `/admin/tenants` | List all tenants |
| PATCH | `/admin/tenants/{id}/active` | Activate/deactivate a tenant |
| GET | `/admin/stats` | System-wide stats |

## Error shape

All error responses use `WriteError` (`internal/httpapi/response.go`):
```json
{ "detail": "human-readable message" }
```
with an appropriate HTTP status code (400/401/403/404/422/500).
