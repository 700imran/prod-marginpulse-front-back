// Last-visit cache so the dashboard can paint real numbers instantly while the
// backend (re)wakes and the fresh data loads behind it — stale-while-revalidate.
//
// What it holds: the dashboard's own summary figures/lists and the profile.
// Because that is business data, the rules are strict:
//   * keyed by the signed-in user's id (from the access token), so one
//     person's cached data can never render for another account;
//   * expires after 24h (MAX_AGE_MS) and is ignored beyond that;
//   * wiped on logout / session loss — tokenManager.clearTokens() calls
//     clearAllCaches();
//   * never trusted as truth: callers always refetch and overwrite it.
// Every localStorage access is wrapped — private mode / quota / corrupt JSON
// must degrade to "no cache", never to an error.
const PREFIX = "mp_cache_v1:";
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

let userIdGetter = () => null;
/** api.js registers how to read the current user's id (kept out of here to avoid an import cycle with tokenManager). */
export function setUserIdGetter(fn) { userIdGetter = typeof fn === "function" ? fn : () => null; }

/** Reads the `sub` claim from a JWT without verifying it — only used to namespace cache keys, never for authorization. */
export function userIdFromToken(token) {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const sub = JSON.parse(atob(payload)).sub;
    return typeof sub === "string" && sub ? sub : null;
  } catch { return null; }
}

function keyFor(name) {
  const uid = userIdGetter();
  return uid ? `${PREFIX}${uid}:${name}` : null; // no known user → no caching
}

export function readCache(name, now = Date.now()) {
  try {
    const key = keyFor(name);
    if (!key) return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { savedAt, data } = JSON.parse(raw);
    if (typeof savedAt !== "number" || now - savedAt > MAX_AGE_MS || now < savedAt - 60_000) return null;
    return { data, savedAt };
  } catch { return null; }
}

export function writeCache(name, data, now = Date.now()) {
  try {
    const key = keyFor(name);
    if (!key) return;
    localStorage.setItem(key, JSON.stringify({ savedAt: now, data }));
  } catch { /* quota / private mode — fine */ }
}

export function clearAllCaches() {
  try {
    const doomed = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) doomed.push(k);
    }
    doomed.forEach((k) => localStorage.removeItem(k));
  } catch { /* ignore */ }
}
