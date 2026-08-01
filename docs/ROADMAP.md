# Roadmap

Ordered roughly by "what would most reduce risk before / right after
the first paying customer," not strictly by effort. See `BRAIN.md`'s
"Next 10 Tasks" for the same list framed as concrete engineering
tickets with acceptance criteria.

## Near-term (pre- or immediately-post first customer)

1. **Scheduled trigger for missing-invoice detection.** Currently
   on-demand only (`POST /reconciliation/detect-missing-invoices`).
   Add an EventBridge scheduled rule invoking it daily per active
   tenant (or a fan-out Lambda that lists active tenants and enqueues
   one detection task per tenant).
2. **Scheduled trigger for GST sync.** Same shape as above — `POST
   /gst/sync` currently needs to be called; vendor filing status will
   silently go stale between manual/triggered syncs otherwise.
3. **Per-team-member identity in the audit trail.** Every action
   currently attributes to `tenant.OwnerEmail` regardless of which
   invited team member performed it (see `SECURITY.md`). Matters more
   as team accounts get real usage — a CA firm managing multiple
   client tenants will want to know which staff member corrected what.
4. **QRMP / staggered GSTR-3B due dates.** The filing-deadline
   calculation currently assumes standard monthly filers only (see
   `TROUBLESHOOTING.md`). Real product risk if a meaningful fraction of
   users are QRMP quarterly filers — the dashboard would show a wrong
   "days remaining."
5. **CI/CD pipeline.** No automated build/test/deploy pipeline exists
   yet — every deploy in `DEPLOYMENT.md` is a manual CLI sequence.

## Medium-term

6. **ROI calculator on a public marketing page.** The backend endpoint
   is already public/stateless/ready; this repo doesn't contain the
   separate marketing site (per project history) — either add a
   marketing site repo that calls it, or confirm where that site
   actually lives and wire the component there.
7. **Sentry integration.** `SENTRY_DSN` config field exists;
   `internal/logging` doesn't actually send anything to Sentry yet.
8. **Secret rotation tooling.** `SECRET_ROTATION_DAYS` is informational
   only — no automated rotation exists for `JWT_SECRET_KEY`,
   `APP_SECRET_KEY`, or `FIELD_ENCRYPTION_KEY`. At minimum, document a
   manual rotation runbook (see `SECURITY.md`'s note that
   `FIELD_ENCRYPTION_KEY` rotation needs a re-encryption migration
   pass, not just an env var change).
9. **Cursor-based pagination for large tenants.** Several
   `ListByTenant`-style repository methods fetch-all-then-paginate-in-Go
   (see `DATABASE_SCHEMA.md`'s "known scale limits"). Fine today; watch
   for a tenant's document count crossing into the tens of thousands.
10. **Meta webhook signature verification.** The WhatsApp webhook
    currently does the verify-token handshake but doesn't verify
    `X-Hub-Signature-256` on inbound POSTs — worth hardening before
    relying on WhatsApp ingest at scale.

## Longer-term / explicitly deferred, not forgotten

- **OCR engine swap (PaddleOCR/Surya as primary).** Explicitly
  evaluated and deferred in favor of RapidOCR's lower AL2023 risk (see
  `DECISIONS.md`). Revisit only if RapidOCR's accuracy becomes a
  measured, real problem — not speculatively.
- **AWS Textract (or any paid cloud OCR) as a fallback.** Explicitly
  built once, then reverted, on cost-policy grounds (see
  `DECISIONS.md`). Do not re-add without re-confirming the "no
  cloud-dependent paid service" requirement still holds.
