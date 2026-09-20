# Commercial / CA-Workflow Roadmap

This doc translates the Free → Pro → Growth → Scale strategy doc (shared
in chat) into actual engineering tasks. It's the detailed backlog;
`BRAIN.md`'s "Open flags" section has the short version and the pricing-
name conflict that needs resolving before any of this is final.

**Nothing in this doc is built yet.** The current app has 13 single-
tenant screens (see `frontend/src/theme.js`'s `NAV_SECTIONS`) with
cosmetic Free/Pro/Growth badges added, but no multi-client/portfolio
capability, no action-queue/follow-up workflow, and no plan enforcement.
This is the plan for building the parts that don't exist yet.

## 0. Prerequisite: plan enforcement doesn't exist

Correction to an earlier note in this repo's history: `tenants.plan_tier`
**does** exist in the schema (`FREE | STARTER | GROWTH | ENTERPRISE`,
default `FREE`) and is read into the Worker's tenant context
(`src/auth/supabase.ts`, `src/repository/tenants.ts`) — but **nothing
anywhere checks it.** No route returns 402/403 for a wrong plan, no UI
hides a screen based on it. `BillingView.jsx` displays it but that's it.

Also note the DB's tier names (`FREE/STARTER/GROWTH/ENTERPRISE`) are a
**third** naming scheme, different from both the strategy doc
(Free/Pro/Growth/Scale) and the live marketing site's pricing page
(Solo/Growth/CA Firm/Large Firm). All three need reconciling to one set
of names before real enforcement is built — otherwise whoever builds
the `requirePlan()` middleware has to guess which name maps to which.

Building real enforcement means: a `requirePlan(minTier)` Hono
middleware per route, decided against one canonical tier list, plus the
frontend actually hiding (not just badging) screens the tenant's plan
doesn't include.

## 1. New sidebar/nav items needed, by tier

Nothing below exists as a screen yet. Each would be a new entry in
`NAV_SECTIONS` (`frontend/src/theme.js`) plus a new component in
`frontend/src/components/`.

**Growth tier:**
- **Portfolio / Multi-Client Dashboard** — client switcher + aggregate
  view across all of a CA's client tenants. This is the single biggest
  net-new capability Growth needs; almost everything else in Growth
  depends on "which client am I looking at" existing as a concept.
  Today the data model is one-tenant-per-account; multi-client means
  either (a) one login can access several `tenants` rows it has a
  `team_members`-style relationship to, or (b) a new `client_of`
  relationship table. Needs a real data-modeling decision, not just UI.
- **Action Queue** — the "don't just show me 80 mismatches, tell me
  which 5 matter first" feature the strategy doc centers on. New table
  (open/resolved, priority, owner, due date, resolution notes, linked
  to a document/anomaly/vendor), new API routes, new screen. This is
  probably the highest product-value item in this whole list.
- **Vendor Follow-Up automation** — partially exists already:
  `backend-cloudflare/src/routes/comms.ts` has
  `GET /comms/generate-reminder?document_id=&issue_type=` (reminder
  *text* generation). What's missing: actually sending it (email/
  WhatsApp), follow-up history, and a UI to trigger it from the vendor
  list rather than hand-crafting the request.
- **Team Workflow expansion** — `TeamView.jsx` exists (invite/list
  members) but has no assignment (issue → staff member), no staff
  workload view, no per-member audit attribution (`docs/ROADMAP.md`
  item 3 — audit actions still attribute to the tenant owner regardless
  of which invited member acted).

**Scale tier:**
- **Revenue Leakage view** — payment-without-invoice, invoice-without-
  payment detection. No existing pipeline for this at all; would need
  a new reconciliation pass comparing `bank_transactions` against
  `documents` for orphans in both directions.
- **Advanced Anomaly Engine view** — duplicate payments, amount
  variance, vendor-pattern anomalies beyond what `anomalies` table /
  `detectMissingInvoices` already covers.
- **Portfolio Intelligence / Management Dashboard** — aggregate
  risk-across-clients view, depends on the Growth-tier portfolio
  capability existing first.
- **Advanced Audit/Control** — approval workflows, evidence trail.
  `audit_log` table exists; approval-workflow state machine doesn't.

## 2. The "intelligence"/ML question

The strategy doc's "advanced anomaly engine" and "revenue leakage"
language doesn't actually specify machine learning anywhere — it reads
as detection logic (duplicate/variance/pattern rules), which is
statistical/rule-based work, not model training. Framing this as
**Phase 1: rules-based (current `anomalies`/`detectMissingInvoices`
pattern, zero marginal AI cost) → Phase 2: LLM calls only on exception
cases needing judgment (the existing `pipelines/insights.ts` pattern,
already used for the plain-English dashboard summary) → Phase 3: any
real model work, funded once there's revenue to justify it** — matches
how this project has approached AI cost elsewhere in its history.
Nothing here currently calls for "add an ML model" as its own task; it
calls for more rules in the existing detection pipelines.

## 3. Suggested build order

Reordering the strategy doc's Free/Pro/Growth/Scale layout into "what
unblocks what":

1. Reconcile the three pricing/tier name sets (business decision, not
   engineering — blocks #2).
2. `requirePlan()` middleware + real enforcement (blocks selling any of
   this honestly).
3. Action Queue (highest product value, doesn't depend on multi-client).
4. Multi-client/portfolio data model + dashboard (unblocks everything
   else in Growth/Scale).
5. Vendor follow-up send + history (comms.ts already half-exists).
6. Per-member audit attribution (`docs/ROADMAP.md` item 3 — old but
   still open, and Growth's team workflow needs it to mean anything).
7. Team assignment workflow.
8. Revenue leakage / advanced anomaly rules.
9. PDF/client-ready reports.
10. Everything else in Scale.

None of this is started. This is a backlog, not a sprint plan — pick
up from #1 whenever this gets picked up again.
