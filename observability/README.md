# MarginPulse observability

Metrics, traces, logs, real-user monitoring and live production probes — all as code.

```
Browser (RUM: vitals, feature load, JS errors) ──POST /api/v1/telemetry──┐
                                                                          ▼
Cloudflare Worker  ── structured JSON logs ──► Workers Logs (dashboard, searchable)
  telemetry middleware ── OTLP/HTTP push ──► OTel Collector ──► Prometheus ──► Grafana (+ alerts)
  (requests, business events, traces)                         └─► Tempo (traces) ──┘
WhatsApp fallback sidecar (extensions/whatsapp-gateway) ── GET /metrics ──► Prometheus (scrape job, optional)
GitHub Actions probe (every 10 min) ── checks the LIVE site ──► failing run + probe_success metric
```

Why push instead of a `/metrics` scrape endpoint: a Worker is stateless and each request may hit a
different isolate, so a scrape would see random partial counters. Each isolate keeps cumulative
counters and pushes them with its own `service.instance.id`; dashboards use `sum(rate(...))`.

## What is measured

| Signal | Metric | Used for |
|---|---|---|
| Every API request | `http_server_request_duration_seconds` (route **pattern**, method, status, plan) | rate, errors, p50/p95/p99 per route and per plan |
| Payments | `marginpulse_events_total{event="payment",outcome=...}` | verified vs bad_signature / owner_mismatch / not_paid / gateway_error |
| Security | `auth_failed`, `rate_limited`, `webhook_rejected` | stuffing / probing / misconfiguration |
| Captcha | `marginpulse_events_total{event="captcha",outcome=passed\|rejected\|unavailable\|skipped_*,action}` | bot pressure; `skipped_unconfigured` means Turnstile is still off |
| Data pipeline | `document_upload`, `dataset_upload`, `dataset_rows_imported`, `reconciliation_run{outcome}` | throughput and match quality |
| Refresh speed | `marginpulse_web_vital_milliseconds{name="APP_READY"}` | time from page load to usable app (target: < 1 s) |
| Feature speed | `marginpulse_feature_load_milliseconds{view,temp}` | click → screen painted, cold vs warm, per screen |
| Core Web Vitals | `...{name=FCP\|LCP\|INP\|TTFB\|CLS}` (CLS ×1000) | real-browser experience |
| Browser errors | `marginpulse_events_total{event="js_error"}` | crashes users hit |
| Background queue | `marginpulse_events_total{event="queue_task",outcome=ok\|retry\|gave_up\|unknown,task}`, `marginpulse_queue_task_duration_seconds{task}` | OCR / reconciliation / GST / identity retries and dropped work (used to be log-only) |
| Daily cron | `marginpulse_events_total{event="cron_run",outcome=ok\|error\|tenant_error\|purge_error}`, `marginpulse_cron_duration_seconds{task="daily_sweep"}` | missing-invoice sweep + visitor purge actually ran, and how long it took |
| Visitor analytics | `marginpulse_events_total{event="visit",outcome=new\|returning\|no_consent\|bot\|db_error}` | consent-gated tracking health (no visitor id or IP ever becomes a label) |
| UPI backup | `marginpulse_events_total{event="payment",outcome=upi_order_created\|upi_utr_submitted\|upi_gateway_error\|upi_mismatch\|…}` | the Razorpay fallback path |
| Capacity | `marginpulse_events_total{event="shed",route}`, `{event="db_unavailable"}`, `{event="quota",outcome="blocked",resource}` | load shedding on heavy endpoints, database overload (503s), Free-plan limit hits (402) |
| WhatsApp backup | Worker: `event="whatsapp_gateway"`; sidecar `/metrics`: `mp_wa_connection_up`, `mp_wa_spool_files`, `mp_wa_forward_attempts_total{result}` | session health, disk-spool backlog, signature/secret mismatches |

Attribute names Prometheus reserves (`job`, `instance`, `le`, `quantile`, `__*`) are renamed (`job` → `job_attr`) by
the registry itself: the collector drops a *whole metric* if one of them collides with its own labels, which
once silently hid the cron duration.

**Privacy:** metric labels are restricted to short enum-like tokens (`safeLabel`); emails, tenant ids,
names, amounts and free text never enter a metric. Logs carry a salted 12-hex tenant hash, never the id or
email, and error text from browsers is scrubbed (emails / URLs / long numbers). Users can opt out per
browser with `localStorage.setItem('mp_telemetry_off','1')`.

## Turn it on

The Worker already logs and counts. Exporting is off until you give it a destination (nothing breaks without it).

**A. Grafana Cloud (no servers):** create a stack → *Connections → OpenTelemetry* → copy the OTLP endpoint
and token, then:
```bash
cd backend-cloudflare
wrangler secret put OTLP_ENDPOINT   # https://otlp-gateway-<region>.grafana.net/otlp
wrangler secret put OTLP_HEADERS    # Authorization=Basic <base64 instanceId:token>
wrangler secret put TELEMETRY_SALT  # any random string
```
Import `grafana/dashboards/marginpulse.json` (Dashboards → Import) and load `alert-rules.yml` as alert rules.

**B. Self-hosted:** `cd observability && OTLP_AUTH_TOKEN=$(openssl rand -hex 32) GRAFANA_ADMIN_PASSWORD='…' docker compose up -d`,
put the collector's `:4318` behind a TLS tunnel (Cloudflare Tunnel / Caddy), then set the same three secrets with
`OTLP_HEADERS=Authorization=Bearer <OTLP_AUTH_TOKEN>`.

Optional extras: uncomment the `[[analytics_engine_datasets]]` block in `wrangler.toml` for per-request SQL
analytics; set repo variable `SUPABASE_URL` and secret `SUPABASE_ANON_KEY` so the probe also verifies that the
public anon key cannot read tenant data.

## How this was verified (not just written)

* Worker telemetry code → real OTel Collector (bearer auth enforced: no token → 401) → real Prometheus: metric
  names and labels in the dashboard/alerts match what is produced, and all 55 dashboard + alert PromQL
  expressions execute without error against live series (26 of them against series that existed in the run).
* **Failure handling, live:** the collector was stopped mid-run → the Worker logged `otlp_export_failed`
  (with `consecutiveFailures`, `retryInMs`), kept its spans, backed off exponentially (10 s → 5 min cap) instead of
  hammering, and delivered everything once the collector came back; the API was never slowed or broken.
* Queue retry/give-up and cron outcomes were driven through the real consumer/`scheduled()` handlers and read back
  from Prometheus (`queue_task` ok/retry/gave_up, `cron_run` ok, durations).
* `promtool test rules` proves each alert fires when it should and stays quiet when it shouldn't (`alert-tests.yml`, 26 rules).
* `probe.test.mjs` proves the probe passes a healthy system and fails a broken one (open endpoints, missing headers,
  evil CORS origin, a database that leaks without RLS).
* Unit/integration tests cover histogram math, OTLP payload shape, PII-free labels/logs, reserved-label renaming,
  collector outage tolerance, RUM ingest, queue/cron metrics and flush behaviour.
* **It already paid for itself:** the live run showed `cron_run{outcome="tenant_error"}` firing for 63 of 224 test
  tenants. Cause: the missing-invoice sweep queried Postgres with the date `0000-01-01` (no year 0 exists), so
  *every tenant with at least one vendor* failed in production's daily cron. Fixed (`0001-01-01`) with a regression
  test on real Postgres; `CronRunFailed` is the alert that would have caught it.

**Not verified:** a live Cloudflare/Supabase deployment (credentials are yours to add), and the Grafana UI itself —
dashboards were validated by running their PromQL against real Prometheus, not by rendering them in Grafana.
The WhatsApp sidecar's `/metrics` is tested in isolation; a real WhatsApp pairing needs a phone.

## Runbook

* **ApiHighErrorRate / ApiSlowP95** — Grafana → "p95 latency by route" to find the route; Cloudflare dashboard → Workers Logs,
  filter `status >= 500`, use `requestId` from the response header.
* **PaymentVerificationFailures** — look at the `outcome` split: `bad_signature` → Razorpay secret rotated/mismatch;
  `gateway_error` → Razorpay status/keys; `owner_mismatch` → someone replaying another tenant's order (security event).
* **AuthFailureSpike / RateLimitingSpike** — check `reason`/`limiter`; sustained from one IP → block it in Cloudflare WAF.
* **ApiNoTelemetry** — Worker not receiving traffic, or OTLP secrets/collector broken (`otlp_export_failed` appears in Workers Logs).
* **RefreshSlow / WarmFeatureSlow** — compare cold vs warm per screen; warm should be near-instant (cache). If not, check `mp:data-updated` churn and API p95.
* **QueueTasksRetrying / QueueTaskGaveUp** — the `task` label names the failing job (`run_ocr_pipeline`, `run_reconciliation`, `reconcile_tenant`, `sync_gst_portal`, `verify_tax_identifier`, `verify_bank_account_task`).
  Workers Logs: `task_failed` (retrying) or `task_gave_up` (dropped after 6 tries; the document stays `PENDING`). Usually a
  provider outage; once it is back, re-upload or re-trigger the document.
* **CronRunFailed / CronNotRunning** — `scheduled_sweep_failed_for_tenant` (one tenant; the sweep continues for the rest),
  `visitor_purge_failed`, or `cron_failed` (whole run; Cloudflare also marks the invocation failed). `CronNotRunning` =
  no successful run in 27 h: check *Workers → Triggers → Cron* and that the OTLP secrets are set.
* **UpiGatewayErrors / UpiAmountMismatch** — gateway down or credentials wrong; a mismatch is *never* auto-applied: review it via the admin API
  (`GET /api/v1/admin/upi-payments`, then `POST …/:id/approve` or `…/reject`) and decide manually. Manual-UTR mode needs no gateway and keeps working.
* **WhatsAppDisconnected / WhatsAppSpoolBacklog / WhatsAppForwardRejected** — see `extensions/whatsapp-gateway/README.md`.
  Rejected = the shared webhook secret differs between sidecar and Worker. Nothing is lost while the Worker is
  unreachable: files wait in the sidecar's spool and are re-sent with backoff.
* **VisitorStoreFailures** — database/migration problem (`db/003_visitors.sql` applied?). The site is unaffected.
* **DatabaseUnavailable** — the API is returning 503 `BUSY` (clients retry with jittered backoff, so users mostly see a short delay).
  Look at Supabase (paused project on the Free plan? connection count? CPU) and the Hyperdrive config. Workers Logs: `db_unavailable`
  with the Postgres/Node error `code`. See `docs/CAPACITY.md` for the connection budget.
* **LoadSheddingActive** — uploads/imports are being refused to protect the database. Normal for a short surge. If it stays up, the
  system is under-provisioned for the traffic: upgrade the database tier / Hyperdrive limit first, then (and only then) raise `MAX_HEAVY_INFLIGHT`.
* **FreePlanQuotaBlocking** — informational: users are hitting `FREE_DOCS_PER_MONTH` / `FREE_BANK_ROWS_PER_MONTH`. Either an upsell signal or limits that are too tight.
