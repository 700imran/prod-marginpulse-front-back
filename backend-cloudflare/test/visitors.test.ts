// Visitor tracking building blocks (pure): user-agent parsing, bot filtering, IP minimisation, identity validation,
// optional Fingerprint server-side verification. No network, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUserAgent, isLikelyBot, truncateIp, validateFirstPartyId, validateFingerprintRequestId, resolveVisitorIdentity, bucketCity } from "../src/pipelines/visitors.ts";

const UA = {
  chromeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  edgeWin: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
  chromeAndroid: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
  androidTablet: "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  chromeIos: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1",
  samsung: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
  opera: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/111.0.0.0",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  headless: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36",
};

test("parseUserAgent: browser / OS / device for the mainstream clients", () => {
  assert.deepEqual(parseUserAgent(UA.chromeWin), { device: "desktop", browser: "Chrome", os: "Windows", bot: false });
  assert.deepEqual(parseUserAgent(UA.edgeWin), { device: "desktop", browser: "Edge", os: "Windows", bot: false });
  assert.deepEqual(parseUserAgent(UA.safariMac), { device: "desktop", browser: "Safari", os: "macOS", bot: false });
  assert.deepEqual(parseUserAgent(UA.firefoxLinux), { device: "desktop", browser: "Firefox", os: "Linux", bot: false });
  assert.deepEqual(parseUserAgent(UA.chromeAndroid), { device: "mobile", browser: "Chrome", os: "Android", bot: false });
  assert.deepEqual(parseUserAgent(UA.androidTablet), { device: "tablet", browser: "Chrome", os: "Android", bot: false });
  assert.deepEqual(parseUserAgent(UA.iphone), { device: "mobile", browser: "Safari", os: "iOS", bot: false });
  assert.deepEqual(parseUserAgent(UA.ipad), { device: "tablet", browser: "Safari", os: "iOS", bot: false });
  assert.deepEqual(parseUserAgent(UA.chromeIos), { device: "mobile", browser: "Chrome", os: "iOS", bot: false });
  assert.deepEqual(parseUserAgent(UA.samsung), { device: "mobile", browser: "Samsung Internet", os: "Android", bot: false });
  assert.deepEqual(parseUserAgent(UA.opera), { device: "desktop", browser: "Opera", os: "Windows", bot: false });
});

test("parseUserAgent: crawlers, headless browsers, tools and an empty UA are bots", () => {
  for (const ua of [UA.googlebot, UA.headless, "curl/8.5.0", "python-requests/2.32", "Lighthouse", "Mozilla/5.0 (compatible; UptimeRobot/2.0)", "", undefined, null]) {
    assert.equal(parseUserAgent(ua as string).bot, true, String(ua));
    assert.equal(parseUserAgent(ua as string).device, "bot");
  }
});

test("isLikelyBot: Cloudflare bot score (when the plan provides it) and verified bots", () => {
  assert.equal(isLikelyBot(UA.chromeWin), false);
  assert.equal(isLikelyBot(UA.chromeWin, { botManagement: { score: 5 } }), true);
  assert.equal(isLikelyBot(UA.chromeWin, { botManagement: { score: 85 } }), false);
  assert.equal(isLikelyBot(UA.chromeWin, { botManagement: { verifiedBot: true } }), true);
  assert.equal(isLikelyBot(UA.googlebot), true);
});

test("truncateIp keeps the network, drops the host (data minimisation)", () => {
  assert.equal(truncateIp("203.0.113.57"), "203.0.113.0");
  assert.equal(truncateIp("2001:db8:85a3:8d3:1319:8a2e:370:7348"), "2001:db8:85a3::");
  assert.equal(truncateIp("2001:db8::1"), "2001:db8:0::");
  assert.equal(truncateIp("::1"), "0:0:0::");
  assert.equal(truncateIp("::ffff:203.0.113.57"), "203.0.113.0");
  assert.equal(truncateIp("not-an-ip"), null);
  assert.equal(truncateIp(""), null);
  assert.equal(truncateIp(undefined), null);
});

test("identity formats: first-party UUIDv4 and Fingerprint request ids only", () => {
  assert.ok(validateFirstPartyId("3f1c6b52-2b6a-4c55-9e0f-0a5a2d7d9f10"));
  assert.ok(!validateFirstPartyId("3f1c6b52-2b6a-1c55-9e0f-0a5a2d7d9f10")); // not v4
  assert.ok(!validateFirstPartyId("'; drop table visitors;--"));
  assert.ok(!validateFirstPartyId("x".repeat(500)));
  assert.ok(validateFingerprintRequestId("1708102555327.NLOjmg"));
  assert.ok(!validateFingerprintRequestId("../../etc/passwd"));
  assert.ok(!validateFingerprintRequestId("1708102555327"));
});

test("bucketCity normalises what Cloudflare gives us and never stores junk", () => {
  assert.equal(bucketCity("Mumbai"), "Mumbai");
  assert.equal(bucketCity("  New Delhi "), "New Delhi");
  assert.equal(bucketCity(undefined), null);
  assert.equal(bucketCity("x".repeat(200)), null);
  assert.equal(bucketCity("<script>alert(1)</script>"), null);
});

const FP_ENV = { FPJS_SECRET_KEY: "secret", FPJS_API_BASE: "https://api.fpjs.io" };
const fpEvent = (over: Record<string, unknown> = {}) => ({ products: { identification: { data: { visitorId: "AbCdEfGhIjKlMnOpQrSt", timestamp: Date.now(), ip: "203.0.113.57", ...over } } } });

test("resolveVisitorIdentity: first-party id when no Fingerprint key is configured", async () => {
  const r = await resolveVisitorIdentity({}, { visitorId: "3f1c6b52-2b6a-4c55-9e0f-0a5a2d7d9f10" }, "203.0.113.57");
  assert.deepEqual(r, { ok: true, id: "3f1c6b52-2b6a-4c55-9e0f-0a5a2d7d9f10", source: "first_party" });
  assert.deepEqual(await resolveVisitorIdentity({}, { visitorId: "nope" }, "203.0.113.57"), { ok: false, error: "invalid visitor id" });
  assert.deepEqual(await resolveVisitorIdentity({}, {}, "203.0.113.57"), { ok: false, error: "visitor id required" });
});

test("resolveVisitorIdentity: with a Fingerprint key the SERVER verifies the requestId and the browser's visitorId is never trusted", async () => {
  const calls: string[] = [];
  const ok = async (url: string, init: RequestInit) => { calls.push(`${url}|${(init.headers as Record<string, string>)["Auth-API-Key"]}`); return new Response(JSON.stringify(fpEvent()), { status: 200 }); };
  const r = await resolveVisitorIdentity(FP_ENV, { requestId: "1708102555327.NLOjmg", visitorId: "3f1c6b52-2b6a-4c55-9e0f-0a5a2d7d9f10" }, "203.0.113.57", ok as never);
  assert.deepEqual(r, { ok: true, id: "fp_AbCdEfGhIjKlMnOpQrSt", source: "fingerprint" });
  assert.deepEqual(calls, ["https://api.fpjs.io/events/1708102555327.NLOjmg|secret"]);
  // a Fingerprint-configured server ignores a bare first-party id (it would let anyone forge visitors)
  assert.deepEqual(await resolveVisitorIdentity(FP_ENV, { visitorId: "3f1c6b52-2b6a-4c55-9e0f-0a5a2d7d9f10" }, "203.0.113.57", ok as never), { ok: false, error: "requestId required" });
});

test("resolveVisitorIdentity: rejects unknown, stale, replayed-from-another-IP and failing Fingerprint events", async () => {
  const mk = (res: Response) => (async () => res) as never;
  const bad = { requestId: "1708102555327.NLOjmg" };
  assert.deepEqual(await resolveVisitorIdentity(FP_ENV, bad, "203.0.113.57", mk(new Response("{}", { status: 404 }))), { ok: false, error: "unverified" });
  assert.deepEqual(await resolveVisitorIdentity(FP_ENV, bad, "203.0.113.57", mk(new Response(JSON.stringify(fpEvent({ timestamp: Date.now() - 10 * 60_000 })), { status: 200 }))), { ok: false, error: "unverified" }); // 10 min old
  assert.deepEqual(await resolveVisitorIdentity(FP_ENV, bad, "198.51.100.9", mk(new Response(JSON.stringify(fpEvent()), { status: 200 }))), { ok: false, error: "unverified" }); // different IP
  assert.deepEqual(await resolveVisitorIdentity(FP_ENV, bad, "203.0.113.57", mk(new Response(JSON.stringify({ products: {} }), { status: 200 }))), { ok: false, error: "unverified" });
  const boom = (async () => { throw new Error("timeout"); }) as never;
  assert.deepEqual(await resolveVisitorIdentity(FP_ENV, bad, "203.0.113.57", boom), { ok: false, error: "verification unavailable" });
});
