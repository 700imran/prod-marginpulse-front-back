# Contributing / Coding Standards

## No automated tests exist yet

Be direct about this: **there are zero `_test.go` files in the backend
and no test suite in the frontend** as of this handover. Every claim
of correctness in this codebase rests on `go build`, `go vet`,
`gofmt -l`, and manual verification (real invoice uploads, checking
DynamoDB items directly) — not on unit/integration tests. If you're
picking up work here, adding tests around whatever you touch is higher
leverage than almost anything else on the roadmap, precisely because
there's currently no safety net at all.

## Backend (Go)

- **One file per entity** in `internal/repository/` — if you add a new
  entity, add a new file, don't grow an existing one past its entity
  boundary.
- **One file per resource area** in `internal/httpapi/` — e.g.
  `document_handlers.go`, `reconciliation_handlers.go`. New endpoints
  go in the matching existing file, or a new file if the resource area
  is genuinely new (see `audit_handlers.go`, `dashboard_handlers.go`,
  `roi_handler.go` for examples of that from this project's history).
- **`internal/db/dynamodb.go` is the single source of truth for key
  construction** — every `pk`/`sk` string is built via a function
  there (`TenantPK`, `DocumentSK`, `AuditLogSK`, etc.). Never hand-build
  a key string inline in a repository file; add a new builder function
  instead, so the key format for an item type only ever exists in one
  place.
- **Comments explain *why*, not *what***. This codebase's existing
  comments consistently explain a tradeoff or a rejected alternative
  (e.g. "same bounded-scan tradeoff as X, fine at this app's expected
  volume") rather than restating the code. Keep that pattern — it's
  what makes `SYSTEM_DESIGN.md`/`DECISIONS.md` possible to write
  accurately from the code itself.
- **Always verify a build before considering work done**:
  ```bash
  gofmt -l .                                              # must be empty
  go vet ./...                                             # must be clean
  go build ./...                                           # must succeed
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/w ./cmd/worker  # Lambda target
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/a ./cmd/api     # Lambda target
  ```
- **New config values**: add to the `Settings` struct in
  `internal/config/config.go`, wire the env var in `Get()`, and add a
  documented line to `.env.example` — all three, every time, so
  `.env.example` never drifts from what the code actually reads.
- **Cost-sensitive changes need explicit sign-off.** Anything that adds
  a paid cloud API call (OCR, storage, third-party enrichment, etc.)
  should be flagged to the product owner before being merged — see
  `DECISIONS.md` #3 for the concrete precedent (a Textract integration
  was built, then explicitly reverted, over exactly this).

## Frontend (React)

- Plain CRA, no CSS framework — inline `style={{}}` objects using the
  CSS custom properties defined in `src/theme.js` (`var(--primary-color)`
  etc.), matching the existing "neomorphism" look. Don't introduce
  Tailwind/styled-components/etc. without discussing it first — it'd
  be an inconsistent second styling system next to every existing
  component.
- **One component per file** in `src/components/`, default-exported,
  named `<Thing>View.jsx` for top-level nav destinations.
- **All API calls go through `src/api.js`** — never call `fetch()`
  directly from a component. Add a new exported function there,
  grouped near related functions with a `// ── Section name ──` comment
  header (existing convention).
- New nav items: add to `NAV_SECTIONS` in `src/theme.js`, then a
  `case` in `App.jsx`'s `renderContent()` switch.
- **Always verify a build before considering work done**:
  ```bash
  npm install
  CI=true npm run build     # must complete with "Compiled successfully"
  ```
  `CI=true` matters — CRA treats ESLint warnings as build-failing
  errors under CI mode, which is what actually gets enforced in a real
  pipeline.

## Git / PR hygiene

No branch/PR convention is established in this repo yet (no
`.github/` templates). Suggested minimum bar until something more
formal exists: one logical change per commit, commit message states
*what* changed and, if not obvious, *why* — matching this codebase's
existing comment style.
