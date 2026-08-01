# Security

## Authentication

- Passwords: bcrypt (`internal/security/password.go`,
  `golang.org/x/crypto/bcrypt`). Never logged, never stored/returned in
  any API response.
- Sessions: JWT access + refresh token pair
  (`internal/security/jwt.go`, `golang-jwt/jwt/v5`). Every token has a
  `jti` (JWT ID) for revocation tracking.
- Logout / revocation: `internal/security/tokenblocklist.go` writes the
  `jti` to Redis with a TTL matching the token's remaining lifetime
  (`RevokeToken`) — `IsRevoked` is checked on every authenticated
  request, so a logged-out token stops working immediately rather than
  waiting out its natural expiry.
- OAuth (Google, Apple): `internal/oauth/`. CSRF protection via a
  Redis-backed one-time state token (`internal/oauth/state.go`) —
  generated before redirecting to the provider, verified on callback,
  then deleted. Tokens are returned to the frontend in the **URL
  fragment**, not the query string, specifically so they're never sent
  to any server or logged by a CDN/proxy along the way — see
  `App.jsx`'s `consumeOAuthCallbackIfPresent()` and
  `oauth_handlers.go`'s `oauthSuccessRedirect`.

## Encryption at rest

- Bank account numbers: AES-256-GCM
  (`internal/security/fieldencryption.go`), keyed by
  `FIELD_ENCRYPTION_KEY` — separate from `JWT_SECRET_KEY` and
  `APP_SECRET_KEY`. `MaskAccountNumber` is used for display (last 4
  digits only) anywhere the full number isn't specifically needed.
- **Not cross-compatible with the original Python version's Fernet
  encryption** (AES-128-CBC+HMAC) — if you're ever migrating an
  existing production database from the old Python backend, bank
  account numbers need a one-time decrypt-with-old-key /
  re-encrypt-with-new-key pass. Not an ongoing concern for a fresh
  deployment.

## Rate limiting

- `internal/ratelimit/ratelimit.go` — a fixed-window counter backed by
  Redis (same algorithm slowapi's Redis backend uses). Applied per
  client IP (`ClientIP(r)`, which respects `X-Forwarded-For` behind API
  Gateway) to auth endpoints and any other sensitive path that needs
  it.

## AI budget guard

- `internal/aibudget/aibudget.go` caps the one LLM call in the codebase
  (the dashboard's plain-English insight, `internal/pipelines/insights`)
  per tenant: `AI_MAX_PROMPT_TOKENS`, `AI_MAX_COMPLETION_TOKENS`,
  `AI_REQUESTS_PER_MINUTE_PER_TENANT`, `AI_DAILY_TOKEN_BUDGET_PER_TENANT`.
  This exists so a single tenant loading the dashboard repeatedly can't
  run away LLM API cost.

## Secrets

All secrets are environment variables, never committed — see
`.env.example` for the full list and `DEPLOYMENT.md` for where they're
set in each environment (Lambda function env vars, Redis, etc.).
`SECRET_ROTATION_DAYS` (default 90) is informational only — there is
**no automated rotation mechanism**; rotating `JWT_SECRET_KEY`,
`APP_SECRET_KEY`, or `FIELD_ENCRYPTION_KEY` today means a manual
redeploy and, for `FIELD_ENCRYPTION_KEY` specifically, a re-encryption
pass over existing bank account records (same shape as the Fernet
migration note above).

## Webhook auth

- WhatsApp webhook: Meta's own verify-token handshake on GET, then
  signature-less POST (Meta's webhook payloads aren't independently
  signed in this implementation — if you need to harden this, add
  Meta's `X-Hub-Signature-256` HMAC verification).
- Email-ingest webhook: a shared secret (`WEBHOOK_INGEST_SECRET`)
  rather than JWT, since the caller is an email-forwarding service, not
  a logged-in user.

## Known gaps (see `TROUBLESHOOTING.md` for more)

- No per-team-member identity in audit trail attribution — every
  action (manual correction, anomaly resolve) is attributed to
  `tenant.OwnerEmail` regardless of which invited team member actually
  performed it. If per-user audit attribution matters before scaling
  team accounts, this needs a real user-identity layer under the
  tenant.
- No automated secret rotation (see above).
- Field encryption key has no versioning — rotating
  `FIELD_ENCRYPTION_KEY` without a migration pass will make existing
  encrypted bank account numbers permanently undecryptable.
