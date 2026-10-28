# MarginPulse observability

Metrics, traces, logs, real-user monitoring and live production probes — all as code.

```
Browser (RUM: vitals, feature load, JS errors) ──POST /api/v1/telemetry──┐
                                                                          ▼
Cloudflare Worker  ── structured JSON logs ──► Workers Logs (dashboard, searchable)
  telemetry middleware ── OTLP/HTTP push ──► OTel Collector ──► Prometheus ──► Grafana (+ alerts)
  (requests, business events, traces)                         └─► Tempo (traces) ──┘
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
| Data pipeline | `document_upload`, `dataset_upload`, `dataset_rows_imported`, `reconciliation_run{outcome}` | throughput and match quality |
| Refresh speed | `marginpulse_web_vital_milliseconds{name="APP_READY"}` | time from page load to usable app (target: < 1 s) |
| Feature speed | `marginpulse_feature_load_milliseconds{view,temp}` | click → screen painted, cold vs warm, per screen |
| Core Web Vitals | `...{name=FCP\|LCP\|INP\|TTFB\|CLS}` (CLS ×1000) | real-browser experience |
| Browser errors | `marginpulse_events_total{event="js_error"}` | crashes users hit |

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
  names and labels in the dashboard/alerts match what is produced, and all 33 dashboard + alert PromQL
  expressions execute without error against live series.
* `promtool test rules` proves each alert fires when it should and stays quiet when it shouldn't (`alert-tests.yml`).
* `probe.test.mjs` proves the probe passes a healthy system and fails a broken one (open endpoints, missing headers,
  evil CORS origin, a database that leaks without RLS).
* 9 unit tests cover histogram math, OTLP payload shape, PII-free labels/logs, collector outage tolerance, RUM ingest.

**Not verified:** a live deployment — Cloudflare/Supabase credentials for the collector and anon key are yours to add.

## Runbook

* **ApiHighErrorRate / ApiSlowP95** — Grafana → "p95 latency by route" to find the route; Cloudflare dashboard → Workers Logs,
  filter `status >= 500`, use `requestId` from the response header.
* **PaymentVerificationFailures** — look at the `outcome` split: `bad_signature` → Razorpay secret rotated/mismatch;
  `gateway_error` → Razorpay status/keys; `owner_mismatch` → someone replaying another tenant's order (security event).
* **AuthFailureSpike / RateLimitingSpike** — check `reason`/`limiter`; sustained from one IP → block it in Cloudflare WAF.
* **ApiNoTelemetry** — Worker not receiving traffic, or OTLP secrets/collector broken (`otlp_export_failed` appears in Workers Logs).
* **RefreshSlow / WarmFeatureSlow** — compare cold vs warm per screen; warm should be near-instant (cache). If not, check `mp:data-updated` churn and API p95.
