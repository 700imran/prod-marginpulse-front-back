// One place for the API base URL and for network calls that must never hang forever.
export const API_BASE = process.env.REACT_APP_API_URL || '';

/** Mutable on purpose: tests shorten these. Values are milliseconds. */
export const TIMEOUTS = { script: 15000, order: 20000, verify: 30000 };

export async function fetchWithTimeout(url, init = {}, ms = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    if (e?.name === 'AbortError') { const err = new Error('Request timed out'); err.code = 'TIMEOUT'; throw err; }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
