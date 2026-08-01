# Platform Admin Panel

A separate panel from every tenant's normal dashboard — for whoever
operates MarginPulse Pro itself, not for customers. Gated by
`tenant.is_platform_admin` (backend: `RequirePlatformAdmin` middleware;
frontend: an extra nav section that only renders when this flag is true).

## What it does

1. **Platform Settings** — edit Google/Apple/Slack OAuth credentials and
   flip global feature flags (AI insights, WhatsApp ingest, per-provider
   integration on/off, new-signups pause) **without a redeploy**. Stored
   in DynamoDB (`PLATFORM` / `SETTINGS` item), overriding the `.env`
   defaults — see `internal/platformsettings/platformsettings.go`.
2. **Tenants** — every customer account, with suspend/reactivate.
3. **System Stats** — basic counts from DynamoDB. Error rates, latency,
   and DLQ depth live in CloudWatch (see `MONITORING.md`), not here.

## Granting the first platform admin

There is **deliberately no API endpoint or UI button** to make yourself
a platform admin — that would let a compromised regular account
escalate into seeing every other customer's data. The only way to grant
it is a direct DynamoDB write, run by whoever controls the AWS account:

```bash
aws dynamodb update-item \
  --table-name marginpulse-production \
  --key '{"pk": {"S": "TENANT#<your-tenant-id>"}, "sk": {"S": "METADATA"}}' \
  --update-expression "SET is_platform_admin = :true" \
  --expression-attribute-values '{":true": {"BOOL": true}}'
```

Find your `<your-tenant-id>` from the JWT you get back at login (the
`tenant_id` field), or via `aws dynamodb scan` filtered on your email.

## Security notes

- `RequirePlatformAdmin` runs the SAME JWT/revocation/active-account
  checks as every other authenticated route, plus the admin flag check
  — it is not a separate, weaker auth path.
- OAuth/integration secrets entered in the panel are encrypted at rest
  with the same AES-256-GCM used for bank account numbers
  (`internal/security/fieldencryption.go`) — never stored or returned
  to the browser in plaintext (the API masks them as `••••••••` once set).
- `HandleListAllTenants` uses a DynamoDB **Scan**, the one deliberate
  exception to this codebase's "no Scan" rule elsewhere — acceptable
  because it's an admin-only, low-frequency screen; see the code
  comment in `internal/repository/tenants.go`'s `ListAll` for why a 4th
  GSI wasn't worth it just for this.
