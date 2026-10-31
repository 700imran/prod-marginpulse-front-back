# Security

This document describes the controls that are **actually implemented and
tested in this repository**, what still needs a one-time action by whoever
operates the deployment, and what is deliberately not covered. It is aligned
to OWASP ASVS (L2) and the control areas auditors look at for SOC 2 / ISO 27001
(access control, change management, cryptography, logging, vulnerability
management). It is **not** a certification — no third party has audited it.

Run `npm test` in `backend-cloudflare/`: the security tests below are part of
that suite and part of the CI gate that blocks deploys.

## 1. Controls implemented

| Area | Control | Where / how it is verified |
|---|---|---|
| Authentication | Supabase JWT verified against JWKS (cached per isolate); issuer, `aud=authenticated`, `role`, algorithm allow-list (RS256/ES256), expiry; anon/service tokens rejected | `auth/supabase.ts`; `security.test.ts` (forged/malformed tokens, every `/api/v1` route 401 without a token) |
| Tenant isolation | Every query on a per-tenant table carries `tenant_id`, including ID-only updates (defense in depth) | `tenant-scoping.test.ts` fails the build if a new query omits it |
| Database exposure | **RLS enabled on all tables + all API-role grants revoked** (the anon key ships in the frontend; without this anyone could read every tenant) | `db/002_security_hardening.sql`; test asserts every table in `schema.sql` is covered |
| Audit trail | Append-only `audit_log` (UPDATE blocked; DELETE blocked unless an explicit maintenance flag is set) | `db/002_security_hardening.sql` |
| Payments | Plan price set **server-side**; order re-fetched from Razorpay and checked for tenant, paid status, currency and amount; plan upgrade is idempotent and audited; Razorpay signature is hex HMAC compared in constant time; webhook replay guard | `billing.test.ts` |
| Input validation | Allow-list validator drops unknown/`__proto__` keys, enforces types and ranges; raw SQL only with allow-listed identifiers | `security.test.ts` (SQL-injection regression, `sql.unsafe` scan) |
| Uploads | File signature must match extension (HTML/EXE disguised as PDF rejected), size limits enforced while streaming, filenames sanitised (no header injection / traversal), MIME derived from content not client header | `security/upload.ts`; `security.test.ts` |
| Downloads | Signed, expiring links; HMAC key derived with HKDF (separate from the encryption key) | `storage.ts`; `security.test.ts` |
| Webhooks | Fail **closed** when a secret is missing; WhatsApp `X-Hub-Signature-256`; constant-time compares; media URL allow-list (SSRF) | `security.test.ts` |
| Cryptography | AES-256-GCM field encryption with random 12-byte IV for bank accounts and integration credentials | `security/fieldEncryption.ts` |
| Transport / browser | HSTS, strict CSP (API: `default-src 'none'`; app: no inline scripts, explicit origins), `frame-ancestors 'none'`, nosniff, Referrer/Permissions policy, `Cache-Control: no-store`, CORS allow-list with `Vary: Origin` | `middleware/security.ts`, `frontend/vercel.json`, `frontend/public/_headers`; `security.test.ts` |
| Supply chain | OCR engine/WASM served from our own origin (no runtime CDN code); legacy URL-fragment token login removed; runtime dependency audit = 0 known vulnerabilities; Dependabot weekly | `frontend/scripts/copy-ocr-assets.js`, `.github/dependabot.yml` |
| Bot protection | Cloudflare Turnstile: widget on sign-in / sign-up (token verified by Supabase Auth); Worker verifies tokens server-side for public API routes, pinning hostname + action, fail-closed if Cloudflare is unreachable; site key served from the backend, secret never leaves the Worker | `security/turnstile.ts`; `turnstile.test.ts`, `LoginPage.captcha.test.js` |
| Abuse protection | Per-isolate limiter on every request + Upstash limiter on billing (fail-closed), ROI, webhooks, dataset upload | `middleware/rateLimit.ts` |
| Error handling | Generic JSON errors with a request id; no stack traces; health endpoint discloses nothing | `security.test.ts` |
| Change management | CI blocks deploys unless typecheck, tests and `npm audit` (high+) pass; weekly scheduled audit; CodeQL; full-history secret scan | `.github/workflows/` |

## 2. One-time actions the operator must do (code cannot do these)

1. **Run `backend-cloudflare/db/002_security_hardening.sql`** in the Supabase SQL editor, then run the two verification queries at the bottom of that file. Until this runs, the database is exposed through the public anon key.
2. **Revoke the GitHub personal access token that was pasted into a chat** and use a fine-grained, repo-scoped, short-lived token from now on.
3. Set Worker secrets (`wrangler secret put`): `FIELD_ENCRYPTION_KEY` (32 random bytes, base64), `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `WHATSAPP_APP_SECRET`, `WEBHOOK_INGEST_SECRET`, Upstash credentials. Webhooks refuse requests until their secret exists.
4. In Supabase Auth: enable email confirmation, set minimum password length/strength, and turn on MFA (TOTP) for platform admins.
5. Set `FRONTEND_ORIGIN` to the exact production origin(s). If the API is not served from `api.marginpulse.in` or Supabase is not on `*.supabase.co`, update `connect-src` in `frontend/vercel.json` and `frontend/public/_headers`, or the browser will block those calls.
6. **Turn on Turnstile — in THIS order** (turning on Supabase CAPTCHA before the site sends tokens locks everyone out with `captcha protection: request disallowed (no captcha_token found in request)`):
   (a) deploy this branch; (b) set `TURNSTILE_SITE_KEY` in `wrangler.toml` and `wrangler secret put TURNSTILE_SECRET`, optionally also `REACT_APP_TURNSTILE_SITE_KEY` at frontend build time as a fallback if the API is unreachable; (c) confirm the login page shows the widget; (d) only then enable Supabase CAPTCHA.
   Details: create a Turnstile widget in the Cloudflare dashboard (allowed hostname = your app host), then `wrangler secret put TURNSTILE_SECRET` and set `TURNSTILE_SITE_KEY` in `wrangler.toml`. **In the same step** enable Supabase → Authentication → Attack Protection → CAPTCHA → Turnstile with the same secret; that is what actually protects sign-in/sign-up (they talk to Supabase directly, not through the Worker). The marketing-site ROI form must also send an `X-Turnstile-Token` header (action `roi`) once the secret is set; signed-in dashboard users are exempt.
7. Enable Supabase backups / point-in-time recovery and test a restore; enable branch protection and required status checks on `main`.

## 3. Known gaps (honest list)

- **No third-party assessment.** Commission an independent penetration test before onboarding enterprise customers; this is the main thing a certificate would add.
- **Audit trail attribution:** all actions are attributed to the tenant owner's email, not the individual team member.
- **Key rotation:** `FIELD_ENCRYPTION_KEY` has no versioning; rotating it needs a re-encryption pass.
- **Tokens in browser storage:** Supabase keeps the session in `localStorage`; the strict CSP is the mitigation. Moving to httpOnly cookies would need a backend session layer.
- **Frontend toolchain:** Create React App is unmaintained; its build-time dependencies carry advisories that never ship to the browser. Plan a migration to Vite.
- **Bulk reconciliation writes** are per-row, so uploads are capped at 5,000 rows.
- **Not yet built:** DLP/PII retention policy and automated data-deletion workflow, SIEM export of logs, and formal incident-response runbook.

## 4. Reporting a vulnerability

Email support@marginpulse.in with details; please do not open a public issue.
