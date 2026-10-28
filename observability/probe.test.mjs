// Proves the probe actually DETECTS problems: run it against a healthy fake and a broken fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

function server(handler) { return new Promise((res) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res({ s, url: `http://127.0.0.1:${s.address().port}` })); }); }
const SEC = { 'strict-transport-security': 'max-age=63072000', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" };
import { spawn } from 'node:child_process';
const probe = (env) => new Promise((resolve) => { const p = spawn('node', ['observability/probe.mjs'], { env: { ...process.env, ...env } }); let out = ''; p.stdout.on('data', (d) => (out += d)); p.on('close', (code) => resolve({ code, out })); });

test('healthy system passes every check', async () => {
  const api = await server((req, res) => {
    const origin = req.headers.origin;
    if (req.method === 'OPTIONS') { res.writeHead(204, { ...(origin === 'https://app.test' ? { 'access-control-allow-origin': origin } : {}) }); return res.end(); }
    if (req.url === '/health') { res.writeHead(200, SEC); return res.end('{"status":"ok"}'); }
    if (req.url === '/api/v1/config/public') { res.writeHead(200, SEC); return res.end('{"captcha":{"provider":"turnstile","enabled":true,"siteKey":"1x00000000000000000000AA"}}'); }
    if (req.url === '/api/v1/roi') { res.writeHead(403, SEC); return res.end('{"captcha":true}'); }
    if (req.url.startsWith('/api/v1/webhooks') || req.url.startsWith('/api/v1/billing/webhook')) { res.writeHead(401); return res.end(); }
    res.writeHead(401, SEC); res.end('{}');
  });
  const app = await server((req, res) => { res.writeHead(200, { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'strict-transport-security': 'max-age=63072000' }); res.end('<html><script src="/a.js"></script></html>'); });
  const sb = await server((req, res) => { res.writeHead(req.method === 'POST' ? 401 : 200, { 'content-type': 'application/json' }); res.end('[]'); });
  const r = await probe({ API_URL: api.url, APP_URL: 'https://app.test', SUPABASE_URL: sb.url, SUPABASE_ANON_KEY: 'anon' });
  // app check uses APP_URL for CORS origin; point the page check at the fake app too
  const r2 = await probe({ API_URL: api.url, APP_URL: app.url, SUPABASE_URL: sb.url, SUPABASE_ANON_KEY: 'anon' });
  [api, app, sb].forEach((x) => x.s.close());
  assert.match(r.out, /PASS .*\/health/);
  assert.match(r2.out, /PASS .*app: loads with CSP/);
  assert.match(r2.out, /PASS .*RLS — anon key cannot read/);
  assert.match(r.out, /PASS .*captcha challenges anonymous/);
});

test('broken system fails loudly: open endpoints, missing headers, leaking database, evil CORS', async () => {
  const api = await server((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*' }); return res.end(); }
    if (req.url === '/api/v1/config/public') { res.writeHead(200); return res.end('{"captcha":{"enabled":true,"siteKey":"1x00000000000000000000AA","secret":"0x4AAAAAAA-leaked"}}'); } // leaks the secret
    res.writeHead(200); res.end('{"ok":true}');   // no security headers, auth route open
  });
  const sb = await server((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[{"tenant_id":"leak"}]'); }); // RLS off
  const r = await probe({ API_URL: api.url, APP_URL: 'https://app.test', SUPABASE_URL: sb.url, SUPABASE_ANON_KEY: 'anon' });
  [api, sb].forEach((x) => x.s.close());
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL .*security headers/);
  assert.match(r.out, /FAIL .*protected route rejects anonymous/);
  assert.match(r.out, /FAIL .*forged token/);
  assert.match(r.out, /FAIL .*CORS/);
  assert.match(r.out, /FAIL .*public config/);
  assert.match(r.out, /FAIL .*RLS — anon key cannot read/);
  assert.match(r.out, /run db\/002_security_hardening.sql/);
});
