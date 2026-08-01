# Business Overview

## Positioning

MarginPulse Pro is a **Financial Risk Intelligence Platform for GST,
Bank, and Transaction Reconciliation** — built and marketed as decision
intelligence for finance teams, not as "another reconciliation tool."

The one-line pitch: **"Know exactly where your money, ITC, and
compliance risk are before filing."**

This distinction matters for every product decision going forward: a
reconciliation tool's job ends at "here's what didn't match." A
decision-intelligence platform's job is "here's what to do about it,
today, in order of financial impact." Every UI surface should be judged
against that bar — does this screen tell the owner/CA what to act on
next, or does it just show them raw data?

## Purpose

Indian SMBs lose real money to GST Input Tax Credit (ITC) that gets
blocked or delayed — not because the business did anything wrong, but
because a vendor didn't file on time, filed a mismatched invoice, or an
invoice never got reconciled against a bank payment. Finding this
manually means a finance person or CA cross-checking invoices, bank
statements, and the GST portal by hand, every month, invoice by
invoice.

MarginPulse Pro automates that cross-check (OCR → reconciliation → GST
portal comparison) and surfaces the result as a prioritized action
list, not a spreadsheet of matches/mismatches.

## Target users

- **Primary**: Owners/finance leads at Indian SMBs who currently do
  GST/bank reconciliation manually or pay a CA firm to do it monthly.
- **Secondary (CA-enablement)**: Chartered Accountants and CA firms
  managing reconciliation for multiple SMB clients — the platform is
  built to reduce the manual hours a CA spends per client, and to give
  the CA defensible evidence (reconciliation reason, audit trail) for
  every number they sign off on.

## Main features

- **Document ingestion**: upload PDF/image invoices (or forward via
  WhatsApp/email), OCR'd automatically — see `ARCHITECTURE.md` for the
  OCR pipeline.
- **Bank reconciliation**: upload a bank statement CSV; invoices are
  automatically matched to bank transactions by vendor name, amount,
  and date (fuzzy matching, confidence-scored).
- **GST portal sync**: cross-check vendor filing status (GSTR-2B) to
  flag ITC blocked by vendor non-compliance.
- **Daily business dashboard** (`GET /dashboard/insights`) — the
  product's default view, not the mismatch list:
  - Highest ITC risk today
  - Vendors requiring follow-up
  - Filing deadlines approaching (GSTR-1, GSTR-3B)
  - Estimated recoverable ITC
- **Manual correction workflow** — humans can correct any OCR/
  reconciliation field, with a required reason, logged to the audit
  trail, and reconciliation is automatically re-run when relevant.
- **Duplicate and missing invoice detection** — automatic, not
  opt-in.
- **Downloadable reconciliation report (CSV)** — for a CA to review
  offline or attach to a filing.
- **Complete audit trail** — every correction, resolution, and
  auto-detected exception, who/what/when/why.
- **ROI calculator** (`POST /roi-calculator`) — "if I spend ₹X, how
  much ITC/time do I recover" — in-app today; the same public,
  unauthenticated endpoint is ready to embed on a marketing site later.
- **Team accounts, tax-identifier/bank-account management, platform
  admin panel, Slack/Razorpay/Stripe integrations, Google/Apple OAuth
  login** — see `ARCHITECTURE.md` and `API_REFERENCE.md`.

## What "done" looks like for V1 (pre-first-paying-customer)

All 8 items below are implemented and build-verified as of this
handover:

| Requirement | Status |
|---|---|
| OCR confidence score | ✅ (pre-existing) |
| Manual correction workflow | ✅ |
| Reconciliation evidence | ✅ |
| Complete audit trail | ✅ |
| Exception reason for every mismatch | ✅ |
| Downloadable reconciliation report | ✅ |
| Duplicate invoice detection | ✅ |
| Missing invoice detection | ✅ |

See `ROADMAP.md` for what's next after V1.
