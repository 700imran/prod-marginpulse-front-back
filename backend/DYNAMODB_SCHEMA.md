# DynamoDB Schema — MarginPulse Pro (Go)

Single table (`marginpulse-<env>`), 3 GSIs. See `internal/db/dynamodb.go`
for the key-builder functions (single source of truth) and
`internal/repository/*.go` for how each entity uses them.

## Why single-table + 3 GSIs

DynamoDB's always-free tier (25 GB storage, 25 WCU, 25 RCU — forever,
not a trial) is an **account-wide budget shared across every table and
GSI**. One table with 3 GSIs = 4 capacity groups; splitting entities
across 8 separate tables would multiply that far past the free budget.
GSI attribute names (`gsi1pk`/`gsi1sk` etc.) are deliberately generic
and **overloaded across item types** — safe because different item
types write different string *values* into the same attribute name, so
a Query for one item type's key pattern never returns another's.

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
| Audit log | `TENANT#<id>` | `AUDITLOG#<created_at>#<id>` |
| Settings (×3) | `TENANT#<id>` | `SETTINGS#RECONCILIATION` \| `NOTIFICATIONS` \| `INTEGRATIONS` |

## GSI1 — login + status filtering
- Tenant: `gsi1pk=EMAIL#<owner_email>` → login lookup
- Document: `gsi1pk=TENANT#<id>#STATUS#<status>`, `gsi1sk=DOC#<created_at>#<id>` → status-filtered list, efficient COUNT

## GSI2 — sparse operational indexes (attribute only present when relevant)
- Tenant: `gsi2pk=WHATSAPP#<phone>` (only if bound) → WhatsApp webhook routing
- Bank transaction: `gsi2pk=TENANT#<id>#UNMATCHED` (only while UNMATCHED) → reconciliation candidate search, removed once matched
- Document: `gsi2pk=TENANT#<id>#GSTSTATUS#<status>` (only if set) → dashboard mismatch/ITC queries

## GSI3 — rare alternate-key lookups
- Tenant: `gsi3pk=INGEST_EMAIL#<alias>` (only if set) → email-ingest webhook routing
- Team member: `gsi3pk=INVITE_TOKEN#<token>` → accept-invite lookup

## Capacity

4 groups (table + 3 GSIs) × 6 RCU/6 WCU = 24/24, inside the account-wide
25/25 free budget. `infra/dynamodb-table.yaml` also creates
CloudWatch alarms on `ReadThrottleEvents`/`WriteThrottleEvents` as an
early warning before throttling (not cost — provisioned mode doesn't
overage-bill, it throttles) becomes visible to users.

## Known scale limits (see individual repository file comments)

- `Documents.ListByTenant` fetches the full matching set and paginates
  in Go (no native DynamoDB offset pagination) — fine at this app's
  expected per-tenant document volume; revisit with cursor-based
  pagination if a single tenant's documents reach the tens of thousands.
- `Documents.ListInvoicesWithTaxIdentifier` (GST vendor-status) and
  `CountTotal` read every document for a tenant — same reasoning.
- `AuditLogsRepo.ListByTenant` with an entity filter scans a tenant's
  full AUDITLOG# range and filters in Go, same reasoning — the audit
  trail is write-once and read infrequently (one document's history at
  a time), so this is the right place to accept an unindexed scan
  rather than add a 4th GSI against the account-wide free-tier budget.
