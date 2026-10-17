# Monitoring & observability

What exists in code, what's free from Cloudflare with zero setup, and
what you still need to turn on yourself. Written against the state in
STATUS.md's "Monitoring & observability" section — read that first if
you haven't.

## What's free already, no code or signup required

Cloudflare's dashboard gives you this automatically for every Worker,
queue, and R2 bucket, with no instrumentation needed:

- **Workers**: requests, error rate, CPU time, wall-clock duration,
  percentiles — Workers & Pages > `marginpulse-cloudflare` > Metrics.
- **Queues**: messages in/out, backlog depth, **DLQ depth** — this last
  one matters a lot here, since a non-zero `*-dlq` queue depth means
  jobs are permanently failing and (for credit-reserved tasks) credits
  are being refunded that shouldn't have needed to be. Queues > each
  queue > Metrics.
- **Hyperdrive**: connection count, query latency — Hyperdrive > your
  config > Metrics.

Set an alert (Notifications, top-level in the Cloudflare dashboard) on:
Worker error rate above some threshold, and DLQ depth above zero for
longer than your tolerance (even "1" sustained for 10+ minutes is worth
knowing about).

## What's in code now

- **`src/monitoring.ts`** — `reportError(env, err, opts)`. Always logs a
  structured `monitoring_event` line (captured by Workers Logs — Workers
  & Pages > your Worker > Logs, or `wrangler tail` live). Additionally
  POSTs to Sentry if `SENTRY_DSN` is set. See that file's header comment
  for an important caveat: **the Sentry integration hasn't been
  confirmed against a real Sentry project** — verify it yourself (steps
  below) before trusting it for anything.
- **Wired into**: the global HTTP error handler (unexpected/unhandled
  exceptions only — expected `AppError`s aren't noise-reported), every
  queue task's retryable-failure path (`warning` severity) and
  permanent-DLQ-failure path (`error` severity), and the cron sweep's
  per-tenant and retention-sweep failure paths.
- **`GET /healthz`** — now does a real `select 1` against Postgres and a
  Redis `PING`, not a static `{status:"ok"}`. Postgres failing returns
  `503`; Redis failing is reported in the body but doesn't flip the
  overall status (everything that depends on Redis already degrades
  gracefully rather than hard-failing — see each call site). Point an
  uptime monitor at this URL, not just the Worker's root.

## Setting up Sentry (optional, and verify it before trusting it)

1. Create a Sentry project (any plan with a DSN works).
2. `wrangler secret put SENTRY_DSN` and paste the DSN
   (`https://PUBLIC_KEY@oXXXXX.ingest.sentry.io/PROJECT_ID`).
3. **Verify delivery actually works** — this is the step not to skip.
   Easiest way: temporarily add a one-line test route that `throw`s, call
   it once, then check your Sentry project's Issues tab (hitting a route
   that doesn't exist instead triggers `app.notFound`, which doesn't
   report to Sentry by design — you need an actual unhandled exception).
   If nothing shows up within a minute, the DSN parsing or the Store API
   call is wrong for your project — don't assume it's working.
4. Set up Sentry's own alert rules once events are confirmed arriving —
   this file doesn't do that for you.

## Usage / cost spikes

Not a dashboard yet, but the data already exists and is tenant-isolated:
`usage_events` and `credit_ledger` (`db/schema.sql`, `src/billing/`)
record every metered call, its outcome, and its cost in credits. A
spike-detection query is just:

```sql
select tenant_id, operation, count(*), sum(credits_consumed)
from usage_events
where created_at > now() - interval '1 hour'
group by tenant_id, operation
order by sum(credits_consumed) desc;
```

Building this into an actual dashboard or scheduled alert (e.g., a
Worker cron that runs a query like this and reports via
`src/monitoring.ts` if any tenant crosses a threshold) is a reasonable
next step — not built in this pass.

## What's still not covered

- No suspicious-login or brute-force detection — login never touches
  this Worker (Supabase Auth handles it directly), so there's nothing
  for this codebase to instrument here. If you need this, it has to be
  built against Supabase's own Auth logs/webhooks, not this repo.
- No automated alert on the usage-spike query above — it's a query you
  can run, not a running job yet.
- No synthetic/scheduled uptime check beyond whatever external monitor
  you point at `/healthz` yourself.
