#!/usr/bin/env node
/**
 * Synthetic production probe — black-box checks from the outside, the way an attacker or
 * a customer sees the system. Exit code 1 if anything fails.
 *
 *   API_URL=https://api.marginpulse.in APP_URL=https://app.marginpulse.in \
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<anon key> node observability/probe.mjs
 *
 * Optional: OTLP_ENDPOINT + OTLP_HEADERS push probe_success / probe_duration_seconds to Grafana/Prometheus.
 */
const API = (process.env.API_URL || '').replace(/\/+$/, '');
const APP = (process.env.APP_URL || '').replace(/\/+$/, '');
const SB = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const ANON = process.env.SUPABASE_ANON_KEY || '';
const LATENCY_BUDGET_MS = Number(process.env.LATENCY_BUDGET_MS || 800);
const TABLES = ['tenants', 'documents', 'bank_transactions', 'bank_accounts', 'tax_identifiers', 'integrations', 'integration_settings', 'team_members', 'audit_log', 'anomalies'];

const results = [];
const check = async (name, fn) => {
  const t0 = performance.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: performance.now() - t0, detail: detail || '' });
  } catch (e) {
    results.push({ name, ok: false, ms: performance.now() - t0, detail: e.message });
  }
};
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const get = (url, init = {}) => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000), ...init });

if (API) {
  await check('api: /health is 200 and fast', async () => {
    const times = [];
    for (let i = 0; i < 5; i++) { const t = performance.now(); const r = await get(`${API}/health`); must(r.status === 200, `status ${r.status}`); times.push(performance.now() - t); }
    times.sort((a, b) => a - b);
    const p95 = times[times.length - 1];
    must(p95 < LATENCY_BUDGET_MS, `slowest of 5 = ${Math.round(p95)} ms (budget ${LATENCY_BUDGET_MS})`);
    return `max ${Math.round(p95)} ms`;
  });
  await check('api: security headers present', async () => {
    const r = await get(`${API}/health`);
    const h = (k) => r.headers.get(k) || '';
    must(/max-age=\d{7,}/.test(h('strict-transport-security')), 'HSTS missing');
    must(h('x-content-type-options') === 'nosniff', 'nosniff missing');
    must(/frame-ancestors/.test(h('content-security-policy')), 'CSP missing');
  });
  await check('api: protected route rejects anonymous callers (401)', async () => {
    const r = await get(`${API}/api/v1/auth/me`);
    must(r.status === 401, `expected 401, got ${r.status}`);
  });
  await check('api: forged token rejected (401)', async () => {
    const r = await get(`${API}/api/v1/auth/me`, { headers: { Authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.' } });
    must(r.status === 401, `expected 401, got ${r.status}`);
  });
  await check('api: telemetry endpoint requires auth', async () => {
    const r = await get(`${API}/api/v1/telemetry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"events":[]}' });
    must(r.status === 401, `expected 401, got ${r.status}`);
  });
  await check('api: webhooks refuse unsigned calls', async () => {
    for (const p of ['/api/v1/webhooks/email-ingest', '/api/v1/billing/webhook']) {
      const r = await get(`${API}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      must([400, 401, 403, 404, 503].includes(r.status), `${p} accepted an unsigned call (HTTP ${r.status})`);
    }
  });
  if (APP) {
    await check('api: CORS allows the app origin only', async () => {
      const ok = await get(`${API}/api/v1/auth/me`, { method: 'OPTIONS', headers: { Origin: APP, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
      must(ok.headers.get('access-control-allow-origin') === APP, `app origin not allowed (${ok.headers.get('access-control-allow-origin')})`);
      const evil = await get(`${API}/api/v1/auth/me`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
      const a = evil.headers.get('access-control-allow-origin');
      must(!a || (a !== '*' && a !== 'https://evil.example'), `evil origin allowed (${a})`);
    });
  }
}

if (APP) {
  await check('app: loads with CSP, HSTS and no framing', async () => {
    const r = await get(`${APP}/`);
    must(r.status === 200, `status ${r.status}`);
    must(/default-src 'self'/.test(r.headers.get('content-security-policy') || ''), 'CSP missing/weak');
    must(/frame-ancestors 'none'/.test(r.headers.get('content-security-policy') || ''), 'frame-ancestors missing');
    must(/max-age=\d{7,}/.test(r.headers.get('strict-transport-security') || ''), 'HSTS missing');
    const html = await r.text();
    must(!/<script>/.test(html), 'inline script present (breaks strict CSP)');
  });
}

if (SB && ANON) {
  await check('supabase: RLS — anon key cannot read any tenant table', async () => {
    const leaks = [];
    for (const t of TABLES) {
      const r = await get(`${SB}/rest/v1/${t}?select=*&limit=1`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}` } });
      if (r.status === 200) {
        const rows = await r.json().catch(() => []);
        if (Array.isArray(rows) && rows.length > 0) leaks.push(`${t} (returned data)`);
      }
    }
    must(leaks.length === 0, `anon can READ: ${leaks.join(', ')} — run db/002_security_hardening.sql`);
  });
  await check('supabase: RLS — anon key cannot write', async () => {
    const r = await get(`${SB}/rest/v1/tenants`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'content-type': 'application/json', Prefer: 'return=minimal' }, body: '{}' });
    must(r.status >= 400, `anon INSERT returned ${r.status}`);
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log('\nMarginPulse production probe');
for (const r of results) console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${pad(r.name, 62)} ${String(Math.round(r.ms)).padStart(5)} ms  ${r.detail}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed\n`);

// Optional push to Grafana / Prometheus (via OTLP) so uptime can be graphed and alerted on.
if (process.env.OTLP_ENDPOINT) {
  const now = String(BigInt(Date.now()) * 1000000n);
  const headers = { 'content-type': 'application/json' };
  for (const part of (process.env.OTLP_HEADERS || '').split(',')) { const i = part.indexOf('='); if (i > 0) headers[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  const attr = (k, v) => ({ key: k, value: { stringValue: v } });
  const gauge = (name, unit, pts) => ({ name, unit, gauge: { dataPoints: pts } });
  const body = { resourceMetrics: [{ resource: { attributes: [attr('service.name', 'marginpulse-probe'), attr('service.instance.id', 'github-actions')] }, scopeMetrics: [{ scope: { name: 'marginpulse.probe' }, metrics: [
    gauge('probe.success', '1', results.map((r) => ({ attributes: [attr('check', r.name)], timeUnixNano: now, asInt: r.ok ? '1' : '0' }))),
    gauge('probe.duration', 's', results.map((r) => ({ attributes: [attr('check', r.name)], timeUnixNano: now, asDouble: r.ms / 1000 }))),
  ] }] }] };
  try { const r = await fetch(`${process.env.OTLP_ENDPOINT.replace(/\/+$/, '')}/v1/metrics`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }); console.log(`telemetry push: HTTP ${r.status}`); } catch (e) { console.log(`telemetry push failed: ${e.message}`); }
}
process.exit(failed.length ? 1 : 0);
