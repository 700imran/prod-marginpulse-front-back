/**
 * rum.js — real-user monitoring. Measures what users actually experience:
 *   • Core Web Vitals (FCP, LCP, CLS, INP, TTFB)
 *   • APP_READY  — page start → app shell painted with the user's name (the "refresh" time)
 *   • feature load — click on a nav item → that screen painted, split cold/warm
 *   • JS errors and unhandled promise rejections (message scrubbed server-side)
 * Sent to POST /api/v1/telemetry (authenticated, allow-listed, size-capped), then
 * exported by the Worker to Grafana / Prometheus. No user content, emails or ids are
 * collected. Opt out per browser: localStorage.setItem('mp_telemetry_off', '1').
 */
import { tokenManager } from '../security/tokenManager';

const BASE = process.env.REACT_APP_API_URL || '';
const MAX_QUEUE = 50;

let queue = [];
let started = false;
let currentView = 'dashboard';
let navStart = null;
let appReadySent = false;
const seenViews = new Set();
const seenErrors = new Set();
const vitals = {};

const disabled = () => { try { return localStorage.getItem('mp_telemetry_off') === '1'; } catch { return false; } };
const round = (n) => Math.max(0, Math.round(n));

function push(e) {
  if (disabled() || queue.length >= MAX_QUEUE) return;
  queue.push(e);
}

export function setView(view) { currentView = view; }

export function startFeature(view) {
  navStart = performance.now();
  currentView = view;
}

/** Call after the screen has committed; waits for the next paint before measuring. */
export function endFeature(view) {
  if (navStart === null) return;
  const t0 = navStart;
  navStart = null;
  const done = () => {
    const temp = seenViews.has(view) ? 'warm' : 'cold';
    seenViews.add(view);
    push({ t: 'feature', view, v: round(performance.now() - t0), temp });
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(done));
  else done();
}

/** First time the shell is painted with identity visible: the refresh-to-usable time. */
export function markAppReady() {
  if (appReadySent) return;
  appReadySent = true;
  const done = () => push({ t: 'vital', name: 'APP_READY', v: round(performance.now()), view: 'dashboard' });
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(done));
  else done();
}

export function reportError(kind, message) {
  const msg = String(message || 'unknown').slice(0, 160);
  const key = `${kind}:${msg}`;
  if (seenErrors.has(key) || seenErrors.size >= 10) return;
  seenErrors.add(key);
  push({ t: 'error', kind, view: currentView, msg });
}

export function flush() {
  if (!queue.length || disabled()) return;
  const token = tokenManager.getAccessToken();
  if (!token) return;
  const batch = queue.splice(0, 25);
  fetch(`${BASE}/api/v1/telemetry`, {
    method: 'POST',
    keepalive: true, // survives page unload
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ events: batch }),
  }).catch(() => { /* telemetry must never surface errors to users */ });
}

function flushVitals() {
  Object.entries(vitals).forEach(([name, v]) => push({ t: 'vital', name, v: round(name === 'CLS' ? v * 1000 : v), view: currentView }));
  Object.keys(vitals).forEach((k) => delete vitals[k]);
}

function observe(type, cb, opts = {}) {
  try {
    const po = new PerformanceObserver((list) => list.getEntries().forEach(cb));
    po.observe({ type, buffered: true, ...opts });
  } catch { /* entry type unsupported in this browser */ }
}

export function initRUM() {
  if (started || typeof window === 'undefined') return;
  started = true;

  window.addEventListener('error', (e) => reportError('js', e.message));
  window.addEventListener('unhandledrejection', (e) => reportError('promise', e.reason?.message || e.reason));

  if ('PerformanceObserver' in window) {
    observe('paint', (e) => { if (e.name === 'first-contentful-paint') vitals.FCP = e.startTime; });
    observe('largest-contentful-paint', (e) => { vitals.LCP = e.startTime; });
    observe('layout-shift', (e) => { if (!e.hadRecentInput) vitals.CLS = (vitals.CLS || 0) + e.value; });
    observe('event', (e) => { if (e.interactionId > 0) vitals.INP = Math.max(vitals.INP || 0, e.duration); }, { durationThreshold: 40 });
    observe('navigation', (e) => { vitals.TTFB = e.responseStart; });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { flushVitals(); flush(); }
  });
  window.addEventListener('pagehide', () => { flushVitals(); flush(); });
  setInterval(flush, 20000);
}

// test hook
export function __reset() { queue = []; started = false; appReadySent = false; navStart = null; seenViews.clear(); seenErrors.clear(); Object.keys(vitals).forEach((k) => delete vitals[k]); }
export function __queue() { return queue; }
