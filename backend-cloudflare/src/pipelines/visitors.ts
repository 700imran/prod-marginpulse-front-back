// Visitor tracking — pure building blocks (no I/O except the optional, injectable Fingerprint call).
//
// What this does and deliberately does NOT do:
//  * It recognises a visitor's browser/device so "new vs returning" can be counted. It never learns a name, phone or
//    email — those only exist once a person logs in or fills a form, and they are never joined to this table.
//  * Geography comes from Cloudflare's own edge headers (city is approximate); no GeoIP database to ship or update.
//  * The user-agent parser is in-house on purpose: ua-parser-js v2 is AGPL and the open-source FingerprintJS v4 is not
//    MIT — neither belongs in a closed-source SaaS without a licence.
//  * IPs are stored truncated to their network (/24, /48): enough for fraud / abuse triage, not a per-device identifier.

export interface UaInfo { device: "desktop" | "mobile" | "tablet" | "bot"; browser: string | null; os: string | null; bot: boolean }

const BOT_RE = /bot\b|bot[/;)\s]|crawl|spider|slurp|headless|phantomjs|puppeteer|playwright|selenium|lighthouse|pingdom|uptime|statuscake|curl\/|wget\/|python-requests|python-urllib|aiohttp|httpx|okhttp\/|go-http-client|java\/|libwww|apache-httpclient|node-fetch|axios\/|postman|facebookexternalhit|telegrambot|whatsapp\/|slackbot|discordbot|linkedinbot|twitterbot|bingpreview|yandex|baiduspider|semrush|ahrefs|mj12|dotbot|petalbot|gptbot|claudebot|ccbot|bytespider/i;

export function parseUserAgent(ua: string | null | undefined): UaInfo {
  const s = (ua ?? "").trim();
  if (!s || BOT_RE.test(s)) return { device: "bot", browser: null, os: null, bot: true };

  const ios = /iPhone|iPad|iPod/.test(s);
  const android = /Android/.test(s);
  const os = ios ? "iOS" : android ? "Android" : /Windows NT/.test(s) ? "Windows" : /CrOS/.test(s) ? "ChromeOS" : /Macintosh|Mac OS X/.test(s) ? "macOS" : /Linux|X11/.test(s) ? "Linux" : null;

  const browser =
    /Edg(?:e|A|iOS)?\//.test(s) ? "Edge"
    : /OPR\/|Opera/.test(s) ? "Opera"
    : /SamsungBrowser\//.test(s) ? "Samsung Internet"
    : /Firefox\/|FxiOS\//.test(s) ? "Firefox"
    : /Chrome\/|Chromium\/|CriOS\//.test(s) ? "Chrome"
    : /Safari\//.test(s) && /Version\//.test(s) ? "Safari"
    : null;

  const tablet = /iPad|Tablet/i.test(s) || (android && !/Mobile/.test(s));
  const mobile = /iPhone|iPod|Mobi/.test(s) || (android && /Mobile/.test(s));
  return { device: tablet ? "tablet" : mobile ? "mobile" : "desktop", browser, os, bot: false };
}

/** UA heuristics plus Cloudflare's own signals when the plan exposes them (Bot Management is an Enterprise feature). */
export function isLikelyBot(ua: string | null | undefined, cf?: { botManagement?: { score?: number; verifiedBot?: boolean } } | null): boolean {
  if (parseUserAgent(ua).bot) return true;
  const bm = cf?.botManagement;
  if (bm?.verifiedBot) return true;
  if (typeof bm?.score === "number" && bm.score < 30) return true; // Cloudflare: 1 = certainly automated, 99 = certainly human
  return false;
}

// ── IP minimisation ─────────────────────────────────────────────────────────
const V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function v4Network(ip: string): string | null {
  const m = V4_RE.exec(ip);
  if (!m || m.slice(1).some((o) => Number(o) > 255)) return null;
  return `${m[1]}.${m[2]}.${m[3]}.0`;
}
function expandV6(ip: string): string[] | null {
  let s = ip.split("%")[0]!.toLowerCase();
  const tail = s.lastIndexOf(":");
  const v4 = V4_RE.exec(s.slice(tail + 1));
  if (v4) { // ::ffff:1.2.3.4 → two hextets
    if (v4.slice(1).some((o) => Number(o) > 255)) return null;
    const hi = ((Number(v4[1]) << 8) | Number(v4[2])).toString(16), lo = ((Number(v4[3]) << 8) | Number(v4[4])).toString(16);
    s = `${s.slice(0, tail + 1)}${hi}:${lo}`;
  }
  if (!/^[0-9a-f:]+$/.test(s) || s.split("::").length > 2) return null;
  const [head, rest] = s.split("::");
  const a = head ? head.split(":") : [], b = rest ? rest.split(":") : [];
  if (s.includes("::")) { const fill = 8 - a.length - b.length; if (fill < 1) return null; return [...a, ...Array(fill).fill("0"), ...b]; }
  return a.length === 8 ? a : null;
}
export function truncateIp(ip: string | null | undefined): string | null {
  const s = (ip ?? "").trim();
  if (!s) return null;
  const direct = v4Network(s);
  if (direct) return direct;
  if (!s.includes(":")) return null;
  const parts = expandV6(s);
  if (!parts || parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  const mapped = parts.slice(0, 5).every((p) => /^0+$/.test(p)) && parts[5] === "ffff"; // IPv4-mapped
  if (mapped) { const hi = parseInt(parts[6]!, 16), lo = parseInt(parts[7]!, 16); return `${hi >> 8}.${hi & 255}.${lo >> 8}.0`; }
  return `${parts.slice(0, 3).map((p) => p.replace(/^0+(?=.)/, "")).join(":")}::`;
}

export function bucketCity(city: string | null | undefined): string | null {
  const s = (city ?? "").trim();
  return /^[\p{L}\p{M}][\p{L}\p{M}\s.'’-]{0,59}$/u.test(s) ? s : null;
}

// ── Identity ────────────────────────────────────────────────────────────────
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FP_REQUEST_RE = /^\d{10,16}\.[A-Za-z0-9]{4,12}$/;
const FP_VISITOR_RE = /^[A-Za-z0-9]{10,40}$/;
export const validateFirstPartyId = (v: unknown): v is string => typeof v === "string" && UUID_V4_RE.test(v);
export const validateFingerprintRequestId = (v: unknown): v is string => typeof v === "string" && FP_REQUEST_RE.test(v);

export type Identity = { ok: true; id: string; source: "first_party" | "fingerprint" } | { ok: false; error: string };
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
const defaultFetch: FetchLike = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(4000) });

const sameFamily = (a: string, b: string) => a.includes(":") === b.includes(":");
const network = (ip: string) => truncateIp(ip) ?? ip;

/**
 * Who is this visitor?
 *  - Fingerprint configured (FPJS_SECRET_KEY): the browser sends only a `requestId`; WE ask Fingerprint's Server API who it
 *    was (the browser's own visitorId is never trusted — anyone could forge it), and require the event to be recent and from
 *    the same network as this request.
 *  - Otherwise: a random first-party UUID the browser generated AFTER consent (no fingerprinting at all).
 */
export async function resolveVisitorIdentity(
  env: { FPJS_SECRET_KEY?: string; FPJS_API_BASE?: string },
  body: { requestId?: unknown; visitorId?: unknown },
  ip: string | null,
  fetchImpl: FetchLike = defaultFetch,
): Promise<Identity> {
  if (env.FPJS_SECRET_KEY) {
    if (!validateFingerprintRequestId(body.requestId)) return { ok: false, error: "requestId required" };
    const base = (env.FPJS_API_BASE || "https://api.fpjs.io").replace(/\/$/, "");
    let res: Response;
    try { res = await fetchImpl(`${base}/events/${body.requestId}`, { headers: { "Auth-API-Key": env.FPJS_SECRET_KEY } }); } catch { return { ok: false, error: "verification unavailable" }; }
    if (!res.ok) return { ok: false, error: "unverified" };
    const json = (await res.json().catch(() => null)) as any;
    const legacy = json?.products?.identification?.data;           // Server API v3 shape (as in the guide)
    const v4 = json?.identification ?? json;                       // newer shape: { identification: { visitor_id }, timestamp, ip_address }
    const visitorId = legacy?.visitorId ?? v4?.visitor_id;
    const ts = Number(legacy?.timestamp ?? json?.timestamp ?? v4?.timestamp);
    const eventIp: string | undefined = legacy?.ip ?? json?.ip_address ?? v4?.ip_address;
    if (typeof visitorId !== "string" || !FP_VISITOR_RE.test(visitorId)) return { ok: false, error: "unverified" };
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 3 * 60_000) return { ok: false, error: "unverified" }; // stale / replayed requestId
    if (eventIp && ip && sameFamily(eventIp, ip) && network(eventIp) !== network(ip)) return { ok: false, error: "unverified" };
    return { ok: true, id: `fp_${visitorId}`, source: "fingerprint" };
  }
  if (body.visitorId === undefined || body.visitorId === null || body.visitorId === "") return { ok: false, error: "visitor id required" };
  if (!validateFirstPartyId(body.visitorId)) return { ok: false, error: "invalid visitor id" };
  return { ok: true, id: body.visitorId.toLowerCase(), source: "first_party" };
}
