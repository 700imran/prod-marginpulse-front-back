# Razorpay payments: how it works, and where real payments get stuck

## The flow

1. Browser → `POST /api/v1/billing/create-order {plan}` — the server picks the price from `PLANS`, creates a Razorpay order with `notes {tenantId, plan}`.
2. Razorpay Checkout opens (script from `checkout.razorpay.com`, iframe from `api.razorpay.com`); the customer pays.
3. The plan is activated by **whichever of these arrives first** (same checks, same idempotent write, per payment id):
   * the browser → `POST /api/v1/billing/verify-payment` (signature check, then the order is re-read from Razorpay: paid in full, INR, right amount, right tenant)
   * Razorpay's server → `POST /api/razorpay/webhook` (`order.paid` / `payment.captured`; HMAC over the raw body with `RAZORPAY_WEBHOOK_SECRET`)

Before this change the webhook only *logged*, so a customer whose browser closed, lost network or was bounced through a UPI app before the confirm call paid
and never got the plan.

## One-call diagnosis

Signed in, call `GET /api/v1/billing/config-check` (same Authorization header the app uses). It returns booleans and a mode — never a key — and `problems[]` in plain words:

| `problems` says | Meaning | Fix |
|---|---|---|
| `…not set … "Razorpay is not configured"` | `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` missing on the Worker → create-order returns 500 | `wrangler secret put RAZORPAY_KEY_ID` / `…_SECRET` |
| `TEST keys (rzp_test_…)` | checkout works but **no real money moves** | put the **Live** key pair (Dashboard → Account & Settings → API Keys) |
| `rejected the key pair (401)` | id and secret do not belong together / secret regenerated | re-copy both |
| `refused … (403)` | account not activated for live (KYC / live access pending) | finish activation in the dashboard |
| `RAZORPAY_WEBHOOK_SECRET is not set` | webhook rejected → paid-but-browser-closed customers get no plan | set it (below) |

## Dashboard checklist (cannot be checked from code)

* **Settings → Payment Capture = Automatic.** With manual capture an authorised payment is never captured and Razorpay auto-refunds it after ~5 days; the order never becomes `paid`, so verification refuses it (the Worker logs `razorpay:order_not_paid`).
* **Webhooks → Add**: URL `https://api.marginpulse.in/api/razorpay/webhook`, events **`order.paid`** and **`payment.captured`**, secret = the value stored as `RAZORPAY_WEBHOOK_SECRET`. Use **Live mode** (test and live have separate webhooks).
* Dashboard → Webhooks → the entry → *Delivery logs*: 2xx = applied/no-op, 5xx = we asked Razorpay to retry (Razorpay unreachable or DB error).

## Things that make a correct payment look "stuck"

* **Hyperdrive query caching** (default on, 60 s + 15 s stale-while-revalidate) can serve the old plan for up to ~75 s after payment. The app reloads 1.5 s after success and may still show the old tier. Fix: turn caching off on the Hyperdrive config (or `--caching-disabled`).
* **`CSP` / `Permissions-Policy`**: `frontend/public/_headers` must allow `checkout.razorpay.com` (script), `api.razorpay.com` (frame) and `*.razorpay.com` (connect/img). The `payment=` permission now also names `https://api.razorpay.com`, the origin of the checkout iframe, so Payment Request / Google Pay flows are not blocked inside it.
* **Frontend build var**: `REACT_APP_API_URL` is baked into the bundle at build time. If it is empty in the Cloudflare build settings every API call goes to the frontend's own domain and fails. Must include `https://`.
* **CI**: deploys run the test suite first; if CI fails nothing is deployed (the 17 Nov deploy failed on a flaky cross-file test, now fixed).
* **`Production probe` workflow is dormant** until the repository variable `API_URL` is set (Settings → Secrets and variables → Actions → Variables); nothing is watching the live API until then.

## Idempotency

`applyPaidPlan` takes a per-payment advisory lock, checks the audit log with `strpos(reason, paymentId)` (not `LIKE` — `_` is a wildcard and an earlier version never matched `pay_…`), upgrades only to a higher tier, and writes the audit entry in the same transaction. Browser and webhook racing is safe; a replayed webhook is a no-op.
