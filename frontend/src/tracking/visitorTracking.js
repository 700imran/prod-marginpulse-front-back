/**
 * visitorTracking.js — consent-gated, first-party visit counting for the app (see backend src/routes/track.ts).
 *
 *  • Nothing is stored or sent until the person clicks "Accept". "Decline" (or Do-Not-Track / Global Privacy Control)
 *    means no id is ever created and no request is made.
 *  • The id is a random UUID v4 kept in localStorage — no fingerprinting, no cookie, never joined to a login.
 *  • One beacon per browser tab session; the server additionally collapses repeats inside 30 minutes.
 *  • Withdrawing consent asks the server to erase the stored visit rows, then forgets the id locally.
 *  • Tracking must never break the app: every failure is swallowed.
 */
const BASE = process.env.REACT_APP_API_URL || '';
export const CONSENT_KEY = 'mp_track_consent'; // 'granted' | 'denied'
export const ID_KEY = 'mp_visitor_id';
export const SENT_KEY = 'mp_visit_sent';        // sessionStorage: already counted in this tab session
export const CONSENT_EVENT = 'mp:tracking-consent';

const store = (kind) => { try { return window[kind]; } catch { return null; } };
const read = (kind, k) => { try { return store(kind)?.getItem(k) ?? null; } catch { return null; } };
const write = (kind, k, v) => { try { store(kind)?.setItem(k, v); return true; } catch { return false; } };
const remove = (kind, k) => { try { store(kind)?.removeItem(k); } catch { /* storage unavailable */ } };

/** A browser-level "don't track me" signal always wins over a previously granted consent. */
export function privacySignalOn() {
  try { return navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true; } catch { return false; }
}

/** 'granted' | 'denied' | null (no decision yet → show the banner). A privacy signal counts as 'denied'. */
export function getConsent() {
  if (privacySignalOn()) return 'denied';
  const v = read('localStorage', CONSENT_KEY);
  return v === 'granted' || v === 'denied' ? v : null;
}

function uuidV4() {
  const c = typeof crypto !== 'undefined' ? crypto : null;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Only call after consent. Returns null when storage is unavailable (then we simply don't track). */
export function getVisitorId() {
  const existing = read('localStorage', ID_KEY);
  if (existing && UUID_RE.test(existing)) return existing;
  const id = uuidV4();
  return write('localStorage', ID_KEY, id) ? id : null;
}

/** Count this tab session once. Resolves to a short reason string (handy in tests, ignored by the app). */
export async function trackVisit({ fetchImpl } = {}) {
  try {
    if (getConsent() !== 'granted') return 'no_consent';
    if (read('sessionStorage', SENT_KEY)) return 'already_sent';
    const visitorId = getVisitorId();
    if (!visitorId) return 'no_storage';
    const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!f) return 'no_fetch';
    write('sessionStorage', SENT_KEY, '1'); // set first: a failed beacon is not retried in a loop
    const res = await f(`${BASE}/api/v1/track/visit`, {
      method: 'POST', credentials: 'omit', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: true, visitorId }),
    });
    return res && res.ok ? 'sent' : `http_${res?.status ?? 0}`;
  } catch { return 'error'; }
}

/** "Erase me": server-side delete, then forget the id. The local id is removed even if the network call fails. */
export async function eraseMyVisits({ fetchImpl } = {}) {
  const visitorId = read('localStorage', ID_KEY);
  remove('localStorage', ID_KEY);
  remove('sessionStorage', SENT_KEY);
  if (!visitorId || !UUID_RE.test(visitorId)) return 'nothing_to_erase';
  try {
    const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
    if (!f) return 'no_fetch';
    const res = await f(`${BASE}/api/v1/track/visitor`, {
      method: 'DELETE', credentials: 'omit', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId }),
    });
    return res && res.ok ? 'erased' : `http_${res?.status ?? 0}`;
  } catch { return 'error'; }
}

/** Record the person's choice. Granting counts this session; declining erases anything already stored. */
export async function setConsent(granted, opts = {}) {
  write('localStorage', CONSENT_KEY, granted ? 'granted' : 'denied');
  try { window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: granted ? 'granted' : 'denied' })); } catch { /* old browser */ }
  return granted ? trackVisit(opts) : eraseMyVisits(opts);
}

/** Forget the decision itself so the banner asks again (used by the "Privacy choices" link). */
export function resetConsent() {
  remove('localStorage', CONSENT_KEY);
  try { window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: null })); } catch { /* old browser */ }
}
