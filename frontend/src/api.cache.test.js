/**
 * Refresh-speed tests: a page refresh must paint from cache in milliseconds
 * even when the network is slow, and must never send an anonymous request.
 */
const SESSION_KEY = 'sb-testproj-auth-token';

function load({ session, fetchImpl }) {
  jest.resetModules();
  process.env.REACT_APP_SUPABASE_URL = 'https://testproj.supabase.co';
  process.env.REACT_APP_API_URL = 'https://api.test';
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  const getSession = jest.fn(() => Promise.resolve({ data: { session: session || null } }));
  jest.doMock('./supabaseClient', () => ({
    supabase: { auth: { getSession, onAuthStateChange: jest.fn(), refreshSession: jest.fn(() => Promise.resolve({ data: {}, error: new Error('x') })), signOut: jest.fn(() => Promise.resolve()) } },
  }));
  global.fetch = jest.fn(fetchImpl);
  return { api: require('./api'), tm: require('./security/tokenManager').tokenManager, getSession };
}

const validSession = () => ({ access_token: 'tok-1', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'asha@acme.in', user_metadata: { full_name: 'Asha Rao' } } });
const json = (v, delay = 0) => () => new Promise((r) => setTimeout(() => r({ status: 200, json: () => Promise.resolve(v) }), delay));

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

test('token and user name exist synchronously at startup (no 401 + refresh round trip)', () => {
  const { tm } = load({ session: validSession(), fetchImpl: json({}) });
  expect(tm.getAccessToken()).toBe('tok-1');
  expect(tm.getUserLabel()).toBe('Asha Rao');
  expect(tm.getTenantId()).toBe('u1');
});

test('first request carries the Authorization header', async () => {
  const { api } = load({ session: validSession(), fetchImpl: json({ items: [] }) });
  await api.listDocuments();
  expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer tok-1');
});

test('REFRESH: second visit paints from cache in milliseconds while the network is slow, then signals fresh data', async () => {
  // visit 1 — cold, 400 ms API
  let a = load({ session: validSession(), fetchImpl: json({ items: [1] }, 400) });
  let t0 = Date.now();
  expect(await a.api.listDocuments()).toEqual({ items: [1] });
  const cold = Date.now() - t0;
  expect(cold).toBeGreaterThanOrEqual(380);

  // age the cache so it is stale (forces a background revalidate)
  const k = Object.keys(sessionStorage).find((x) => x.startsWith('mp_cache:'));
  const e = JSON.parse(sessionStorage.getItem(k)); e.t -= 60_000; sessionStorage.setItem(k, JSON.stringify(e));

  // visit 2 — "page refresh": fresh module instance, sessionStorage survives, API still 400 ms and now returns new data
  const b = load({ session: validSession(), fetchImpl: json({ items: [1, 2] }, 400) });
  const updated = new Promise((res) => window.addEventListener('mp:data-updated', res, { once: true }));
  t0 = Date.now();
  expect(await b.api.listDocuments()).toEqual({ items: [1] }); // instant, from cache
  const warm = Date.now() - t0;
  console.log(`cold load: ${cold} ms  →  after refresh: ${warm} ms (API latency 400 ms)`);
  expect(warm).toBeLessThan(50);

  await updated; // background refresh finished and told the app
  expect(await b.api.listDocuments()).toEqual({ items: [1, 2] }); // next read is fresh AND instant
});

test('fresh data is served with zero network calls', async () => {
  const { api } = load({ session: validSession(), fetchImpl: json({ x: 1 }) });
  await api.getITCSummary();
  await api.getITCSummary();
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('a write clears cached reads so nothing stale is shown', async () => {
  const { api } = load({ session: validSession(), fetchImpl: json({ ok: true }) });
  await api.getReconciliationSettings();
  await api.updateReconciliationSettings({ a: 1 });
  await api.getReconciliationSettings();
  expect(global.fetch.mock.calls.filter((c) => (c[1].method || 'GET') === 'GET').length).toBe(2);
});

test('error payloads are never cached', async () => {
  const { api } = load({ session: validSession(), fetchImpl: json({ error: 'boom' }) });
  await api.listTeamMembers();
  await api.listTeamMembers();
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

test('cache is per user and wiped on logout', async () => {
  const { api } = load({ session: validSession(), fetchImpl: json({ items: [9] }) });
  await api.listDocuments();
  expect(Object.keys(sessionStorage).some((k) => k.startsWith('mp_cache:u1:'))).toBe(true);
  api.clearDataCache();
  expect(Object.keys(sessionStorage).some((k) => k.startsWith('mp_cache:'))).toBe(false);
});

test('expired stored token is refreshed BEFORE the first request, not after a 401', async () => {
  const s = validSession(); s.expires_at = Math.floor(Date.now() / 1000) - 5;
  const { api, getSession } = load({ session: s, fetchImpl: json({ items: [] }) });
  await api.listDocuments();
  expect(getSession).toHaveBeenCalled();
  expect(global.fetch).toHaveBeenCalledTimes(1); // no 401 retry loop
});
