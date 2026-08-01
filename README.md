# MarginPulse Pro

A Financial Risk Intelligence Platform for GST, Bank, and Transaction
Reconciliation for Indian SMBs — CA-enablement, ITC-risk-first, not
"another reconciliation tool." See `docs/BUSINESS_OVERVIEW.md` for the
full positioning and `BRAIN.md` for the complete engineering handover.

## What's in this package

```
/
├── README.md              ← you are here
├── BRAIN.md               ← START HERE if you're picking up development —
│                             full engineering handover: architecture, what's
│                             done, what's pending, exact task in progress,
│                             known bugs, coding standards, next 10 tasks
├── backend/                Go backend — API + worker Lambdas, OCR service
├── frontend/                React frontend (Create React App)
└── docs/                    Deep-dive reference docs (see index below)
```

## Docs index

| File | Covers |
|---|---|
| `docs/BUSINESS_OVERVIEW.md` | Purpose, positioning, target users, features |
| `docs/ARCHITECTURE.md` | Full-stack architecture, frontend/backend/DB/queues/auth/AI pipeline/deployment |
| `docs/SYSTEM_DESIGN.md` | The *why* behind every structural tradeoff |
| `docs/DATA_FLOW.md` | Step-by-step request/document/reconciliation lifecycles |
| `docs/API_REFERENCE.md` | Every endpoint, request/response shapes |
| `docs/DATABASE_SCHEMA.md` | DynamoDB single-table key design, all item types |
| `docs/SECURITY.md` | Auth, encryption, rate limiting, known gaps |
| `docs/DEPLOYMENT.md` | Full deploy walkthrough, infra templates |
| `docs/LOCAL_SETUP.md` | Local dev environment setup |
| `docs/OPERATIONS.md` | Monitoring, alarms, runbooks, cost levers |
| `docs/TROUBLESHOOTING.md` | Known issues, build gotchas, limitations |
| `docs/DECISIONS.md` | Decision log with rationale (read this before reversing a past decision) |
| `docs/ROADMAP.md` | Prioritized next steps |
| `docs/CONTRIBUTING.md` | Coding standards and conventions |

## Fastest path to running this locally

```bash
# Backend
cd backend
cp .env.example .env    # edit as needed — see docs/LOCAL_SETUP.md
go build ./...           # verify it compiles first
go run ./cmd/localserver # http://localhost:8000

# Frontend (separate terminal)
cd frontend
npm install
npm start                # http://localhost:3000
```

Full instructions, including DynamoDB Local / Redis setup:
`docs/LOCAL_SETUP.md`.

## Current status (see `BRAIN.md` for full detail)

All 8 V1 must-have requirements are implemented and build-verified:
OCR confidence score, manual correction workflow, reconciliation
evidence, complete audit trail, exception reason for every mismatch,
downloadable reconciliation report, duplicate invoice detection,
missing invoice detection. The ITC-risk daily dashboard and ROI
calculator (both backend + frontend) are also implemented. Nothing in
this package has been deployed to production — see `BRAIN.md` section
E for the exact state the last working session ended in.
