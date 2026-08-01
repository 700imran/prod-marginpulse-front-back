# Database Schema

Single DynamoDB table (`marginpulse-<env>`), 3 GSIs. Source of truth:
`internal/db/dynamodb.go` (key-builder functions) and
`internal/repository/*.go` (one file per entity). This doc is a human-
readable index into that code, not a replacement for reading it.

## Why single-table + 3 GSIs

DynamoDB's always-free tier (25 GB storage, 25 WCU, 25 RCU — forever,
not a trial) is an **account-wide budget shared across every table and
GSI**. One table with 3 GSIs = 4 capacity groups; splitting entities
across many separate tables would multiply that far past the free
budget. GSI attribute names (`gsi1pk`/`gsi1sk` etc.) are deliberately
generic and **overloaded across item types** — safe because different
item types write different string *values* into the same attribute
name, so a Query for one item type's key pattern never returns
another's.

## Items

| Item type | pk | sk |
|---|---|---|
| Tenant | `TENANT#<id>` | `METADATA` |
| Document | `TENANT#<id>` | `DOCUMENT#<id>` |
| Bank transaction | `TENANT#<id>` | `BANKTXN#<date>#<id>` |
| Tax identifier | `TENANT#<id>` | `TAXID#<id>` |
| Tax identifier guard (uniqueness) | `TENANT#<id>` | `TAXID_GUARD#<type>#<value>` |
| Bank account | `TENANT#<id>` | `BANKACCT#<id>` |
| Team member | `TENANT#<id>` | `TEAMMEMBER#<id>` |
| Anomaly | `TENANT#<id>` | `ANOMALY#<date>#<id>` |
| **Audit log** | `TENANT#<id>` | `AUDITLOG#<created_at>#<id>` |
| Settings (×3) | `TENANT#<id>` | `SETTINGS#RECONCILIATION` \| `NOTIFICATIONS` \| `INTEGRATIONS` |

## Key fields by item (non-exhaustive — see `internal/repository/types.go`
## for the full struct + dynamodbav tags)

**DocumentItem** — `document_id`, `doc_type`, `vendor_name`,
`document_date`, `invoice_number`, `raw_total_amount`, `tax_amount`,
`tax_identifier`, `processing_status`, `ocr_confidence_score`,
`reconciliation_score`, `matched_bank_transaction_id`,
`gst_portal_status`, plus (added for the V1 must-haves):
- `reconciliation_reason` — human-readable evidence/exception string
  for every reconciliation outcome (RECONCILED/MANUAL_REVIEW/UNMATCHED)
- `duplicate_of_document_id` — set by duplicate-invoice detection
- `manually_corrected`, `corrected_by`, `corrected_at` — set by the
  manual correction workflow (full per-field history lives in
  AuditLogItem, not here — these three are just a cheap "was this ever
  touched" flag)

**AnomalyItem** — `anomaly_id`, `document_id` (optional),
`related_transaction_id` (optional — used by MISSING_INVOICE, which
keys off a bank transaction rather than a document), `anomaly_type`
(`DUPLICATE_INVOICE`, `RECONCILIATION_MANUAL_REVIEW`,
`RECONCILIATION_UNMATCHED`, `MISSING_INVOICE`, plus any pre-existing
GST-related types), `severity`, `description`, `suggested_action`,
`status` (`OPEN`/`RESOLVED`), `resolved_at`, `resolved_by`.

**AuditLogItem** (new item type) — `audit_log_id`, `entity_type`
(`DOCUMENT`/`ANOMALY`/`BANKTXN`), `entity_id`, `action`
(`MANUAL_CORRECTION`/`ANOMALY_RESOLVED`/`DUPLICATE_DETECTED`/
`MISSING_INVOICE_DETECTED`), `field_name`, `old_value`, `new_value`,
`reason`, `actor_email`, `created_at`. **Append-only** — `AuditLogsRepo`
has no `Update`/`Delete` method, on purpose (see `SYSTEM_DESIGN.md`).

## GSI1 — login + status filtering
- Tenant: `gsi1pk=EMAIL#<owner_email>` → login lookup
- Document: `gsi1pk=TENANT#<id>#STATUS#<status>`, `gsi1sk=DOC#<created_at>#<id>` → status-filtered list, efficient COUNT

## GSI2 — sparse operational indexes (attribute only present when relevant)
- Tenant: `gsi2pk=WHATSAPP#<phone>` (only if bound) → WhatsApp webhook routing
- Bank transaction: `gsi2pk=TENANT#<id>#UNMATCHED` (only while UNMATCHED) → reconciliation candidate search, removed once matched
- Document: `gsi2pk=TENANT#<id>#GSTSTATUS#<status>` (only if set) → dashboard mismatch/ITC queries — this is what `dashboard/insights` reads

## GSI3 — rare alternate-key lookups
- Tenant: `gsi3pk=INGEST_EMAIL#<alias>` (only if set) → email-ingest webhook routing
- Team member: `gsi3pk=INVITE_TOKEN#<token>` → accept-invite lookup

## Capacity

4 groups (table + 3 GSIs) × 6 RCU/6 WCU = 24/24, inside the account-wide
25/25 free budget. `infra/dynamodb-table.yaml` also creates CloudWatch
alarms on `ReadThrottleEvents`/`WriteThrottleEvents` as an early warning
before throttling (not cost — provisioned mode doesn't overage-bill, it
throttles) becomes visible to users.

## Known scale limits (see individual repository file comments)

- `Documents.ListByTenant` fetches the full matching set and paginates
  in Go (no native DynamoDB offset pagination) — fine at this app's
  expected per-tenant document volume; revisit with cursor-based
  pagination if a single tenant's documents reach the tens of
  thousands.
- `Documents.ListInvoicesWithTaxIdentifier`, `CountTotal`,
  `FindDuplicate`, `ListVendorNames`, `ListAllForExport` all read every
  document for a tenant — same reasoning.
- `AuditLogsRepo.ListByTenant` with an entity filter scans a tenant's
  full AUDITLOG# range and filters in Go — the audit trail is
  write-once and read infrequently (one document's history at a time),
  so this is the right place to accept an unindexed scan rather than
  add a 4th GSI against the account-wide free-tier budget.
- `dashboard.Build` (the ITC-risk dashboard) reuses the GST-status
  reads above, capped to the top 10 items per list — it is a "what to
  act on today" shortlist, not a full report (the CSV export and
  anomalies list cover the exhaustive view).
