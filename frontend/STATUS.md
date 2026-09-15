# MarginPulse Pro frontend — Status

Three changes in this pass, wiring this frontend to the
`backend-cloudflare/` stack (Cloudflare Workers + Supabase + Vercel,
replacing the old Go/AWS backend + wherever this used to deploy).
**None of this has been run against real, live infrastructure** — no
Supabase project, no deployed Worker, no Vercel project exist yet
(see `backend-cloudflare/NEXT_STEPS.md` Phases A/B/G/H). Everything
below was verified with `CI=true npx react-scripts build`, which
compiles and bundles successfully — that confirms the code is
correct and wired together, not that it works end-to-end against
real accounts.

## 1. Auth moved to Supabase (was: this app's own JWT endpoints)

`backend-cloudflare` doesn't have `/api/v1/auth/login`, `/register`,
`/refresh`, or `/logout` endpoints — Supabase Auth issues and
verifies tokens directly now (see
`backend-cloudflare/src/auth/supabase.ts`'s comment). Changed:

- **`src/supabaseClient.js`** (new) — the Supabase client instance.
  Reads `REACT_APP_SUPABASE_URL` / `REACT_APP_SUPABASE_ANON_KEY` at
  build time.
- **`src/security/tokenManager.js`** — rewritten to wrap
  `supabase.auth`'s session instead of managing raw JWTs in
  localStorage itself. Public API (`getAccessToken()`,
  `isAuthenticated()`, `clearTokens()`, listeners) is unchanged, so
  every other file that already used `tokenManager` didn't need to
  change. "Tenant ID" is now the Supabase user's UUID.
- **`src/LoginPage.jsx`** — `LoginForm`/`RegisterForm` call
  `supabase.auth.signInWithPassword` / `signUp` directly instead of
  `apiClient.post('/api/v1/auth/login' | '/register', ...)`.
  Registration passes `business_name`/`country_code` as user metadata,
  which `db/schema.sql`'s `handle_new_auth_user()` trigger reads to
  create the `tenants` row — the trigger was extended to also read
  `country_code` (it only read `business_name` before).
- **`src/api.js`** — `getToken()` now delegates to `tokenManager`
  instead of reading a `mp_access_token` localStorage key directly
  (Supabase persists its session under its own key, not that one, so
  the old direct read would have silently always returned empty).
  `login`/`register`/`refreshToken` (unused dead code — nothing
  outside this file imported them) removed; `logout()`/`isLoggedIn()`
  simplified to delegate to `tokenManager`.
- **`src/security/apiClient.js`** — the 401-retry path now calls
  `supabase.auth.refreshSession()` instead of a `/api/v1/auth/refresh`
  POST.

**Not verified**: no real Supabase project exists to sign up/sign in
against yet, so none of this has actually authenticated against a
live backend. The registration flow also branches on whether Supabase
Auth's "email confirmation" setting is on (no session back from
`signUp` until the link is clicked) or off (session back
immediately) — both branches are handled in code, but only one of
them is true for however this project's Supabase Auth settings get
configured, and it hasn't been checked against a real project either.

## 2. OCR moved entirely client-side (was: AWS Lambda)

New `src/ocr/` module — see
`backend-cloudflare/src/pipelines/ocr.ts`'s header comment for why
(no AWS account for this deployment). Summary:

- `pdfToImage.js` — rasterizes a PDF's first page to a canvas via
  `pdfjs-dist`, since neither OCR engine below reads PDFs directly.
  Only page 1; multi-page documents aren't handled.
- `textDetectorEngine.js` — browser-native Shape Detection API
  (`window.TextDetector`), Chrome/Edge only. Fast, no download, but
  the API gives no confidence score at all — this assigns a fixed
  0.9 rather than a real measurement. Said plainly so it isn't
  mistaken for an actual signal later.
- `tesseractEngine.js` — Tesseract.js (WASM) fallback for
  Safari/Firefox or if TextDetector fails. Real per-line confidence.
- `index.js` — orchestrates: rasterize PDF if needed, try
  TextDetector, fall back to Tesseract.js, return `null` (never
  throw) if neither produces text.
- `api.js`'s `uploadDocument()` runs this before the network request
  and attaches the result as an `ocr_lines` form field, which
  `backend-cloudflare`'s upload handler now expects.

**Known gaps, stated plainly:**
- **WhatsApp and email ingestion get zero OCR.** There's no browser
  in those flows to run any of this — `queue/consumer.ts`'s
  `runOCRPipeline` always resolves `ocrAvailable: false` for those
  channels now. Documents land pending for manual correction. This is
  a real product limitation of going fully client-side, not an
  oversight — flagging it because it wasn't true before.
- **Never tested against a real scanned invoice.** `npm run build`
  confirms the code compiles and bundles; it says nothing about
  Tesseract.js/TextDetector's actual read accuracy on real, messy
  photographed invoices, which was RapidOCR's job before. Try it
  against real documents before trusting the extracted fields.
- Tesseract.js is meaningfully slower than the old Lambda for a
  typical phone-photo of an invoice — expect a few seconds, not
  instant, on first use in a session (it downloads/caches the English
  language data file).

## 3. Vercel deploy config (new)

`vercel.json` — build command + output directory, `framework:
"create-react-app"`. Since this repo also has `backend/`,
`backend-cloudflare/`, and `docs/` at the top level, **the Vercel
project's Root Directory setting must be set to `frontend`** in the
dashboard — `vercel.json` alone can't do that from inside a
subdirectory.

**Required build-time environment variables on Vercel** (Create React
App bakes `REACT_APP_*` into the bundle at build time — set these
*before* the first deploy, and redeploy after changing any of them):
- `REACT_APP_API_URL` — the deployed Cloudflare Worker's URL (Phase G
  in `backend-cloudflare/NEXT_STEPS.md`)
- `REACT_APP_SUPABASE_URL` — from the Supabase project (Phase A)
- `REACT_APP_SUPABASE_ANON_KEY` — from the Supabase project (Phase A).
  This key is meant to be public; it ends up in the JS bundle either
  way. It's Supabase's row-level security and this backend's own
  token verification that actually protect data, not keeping this
  key secret.

None of these three values exist yet — they're only real once Phases
A and G actually happen.
