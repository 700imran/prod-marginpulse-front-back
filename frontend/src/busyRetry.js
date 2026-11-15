/**
 * busyRetry.js — be a good citizen when the server says "busy".
 *
 * During a surge the API answers 503 + Retry-After (load shedding, or the database out of connections) instead of
 * slowing every request to a crawl. A client that immediately re-asks makes the surge worse, so we wait the number
 * of seconds the server asked for PLUS random jitter (so thousands of tabs don't all return in the same millisecond),
 * and give up after a bounded total wait so the screen can show a clear message instead of spinning forever.
 *
 * Safe to use for uploads because the server only answers {code:"BUSY"} when it refused the request before doing any
 * work (shedding) or could not reach the database; anything else (401/402/422/500…) is returned untouched.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function backoffMs(attempt, retryAfterHeader, rnd = Math.random) {
  const asked = Number(retryAfterHeader);
  const base = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 15) * 1000 : Math.min(1000 * 2 ** attempt, 8000);
  return Math.round(base * (1 + rnd() * 0.5)); // +0…50% jitter, never earlier than the server asked
}

export async function fetchRetryingBusy(doFetch, { maxWaitMs = 45000, anyGet = false, sleepImpl = sleep, rnd = Math.random } = {}) {
  let waited = 0;
  for (let attempt = 0; ; attempt++) {
    const res = await doFetch();
    if (res.status !== 503 && !(anyGet && res.status === 429)) return res;
    if (res.status === 503 && !anyGet) {
      let busy = false;
      try { busy = (await res.clone().json())?.code === 'BUSY'; } catch { /* not JSON */ }
      if (!busy) return res;
    }
    const wait = backoffMs(attempt, res.headers?.get?.('Retry-After'), rnd);
    if (waited + wait > maxWaitMs) return res; // out of patience: the caller shows the server's own message
    waited += wait;
    await sleepImpl(wait);
  }
}
