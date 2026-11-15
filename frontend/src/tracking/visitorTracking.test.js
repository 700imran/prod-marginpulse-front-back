/** Consent-gated visit counting: nothing happens without consent; withdrawal erases; failures never throw. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let vt;
const ok = (status = 202) => jest.fn(async () => ({ ok: status < 400, status }));

beforeEach(() => {
  jest.resetModules();
  localStorage.clear(); sessionStorage.clear();
  Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true });
  Object.defineProperty(navigator, 'globalPrivacyControl', { value: undefined, configurable: true });
  vt = require('./visitorTracking');
});

test('no decision → nothing is stored and nothing is sent', async () => {
  const f = ok();
  expect(vt.getConsent()).toBeNull();
  expect(await vt.trackVisit({ fetchImpl: f })).toBe('no_consent');
  expect(f).not.toHaveBeenCalled();
  expect(localStorage.getItem(vt.ID_KEY)).toBeNull();
});

test('accepting creates a random v4 id, sends one credential-less beacon, and counts a tab session only once', async () => {
  const f = ok();
  expect(await vt.setConsent(true, { fetchImpl: f })).toBe('sent');
  expect(f).toHaveBeenCalledTimes(1);
  const [url, init] = f.mock.calls[0];
  expect(url).toBe('/api/v1/track/visit');
  expect(init.credentials).toBe('omit');
  expect(init.headers.Authorization).toBeUndefined();
  const body = JSON.parse(init.body);
  expect(body.consent).toBe(true);
  expect(body.visitorId).toMatch(UUID);
  expect(Object.keys(body).sort()).toEqual(['consent', 'visitorId']);
  expect(localStorage.getItem(vt.ID_KEY)).toBe(body.visitorId);

  expect(await vt.trackVisit({ fetchImpl: f })).toBe('already_sent');
  expect(f).toHaveBeenCalledTimes(1);
});

test('a returning visitor keeps the same id across tab sessions', async () => {
  const f = ok();
  await vt.setConsent(true, { fetchImpl: f });
  const id = localStorage.getItem(vt.ID_KEY);
  sessionStorage.clear();
  expect(await vt.trackVisit({ fetchImpl: f })).toBe('sent');
  expect(JSON.parse(f.mock.calls[1][1].body).visitorId).toBe(id);
});

test('declining erases server-side and forgets the id locally, then never tracks again', async () => {
  const f = ok(200);
  await vt.setConsent(true, { fetchImpl: ok() });
  const id = localStorage.getItem(vt.ID_KEY);
  expect(await vt.setConsent(false, { fetchImpl: f })).toBe('erased');
  expect(f.mock.calls[0][0]).toBe('/api/v1/track/visitor');
  expect(f.mock.calls[0][1].method).toBe('DELETE');
  expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ visitorId: id });
  expect(localStorage.getItem(vt.ID_KEY)).toBeNull();
  const g = ok();
  expect(await vt.trackVisit({ fetchImpl: g })).toBe('no_consent');
  expect(g).not.toHaveBeenCalled();
});

test('the id is dropped locally even when the erase request fails (and failures never throw)', async () => {
  await vt.setConsent(true, { fetchImpl: ok() });
  const boom = jest.fn(async () => { throw new Error('offline'); });
  expect(await vt.setConsent(false, { fetchImpl: boom })).toBe('error');
  expect(localStorage.getItem(vt.ID_KEY)).toBeNull();
  expect(await vt.trackVisit({ fetchImpl: boom })).toBe('no_consent');
});

test('Do-Not-Track / Global Privacy Control override a stored "granted"', async () => {
  localStorage.setItem(vt.CONSENT_KEY, 'granted');
  Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
  const f = ok();
  expect(vt.getConsent()).toBe('denied');
  expect(await vt.trackVisit({ fetchImpl: f })).toBe('no_consent');
  expect(f).not.toHaveBeenCalled();
});

test('a server error or network failure on the beacon is swallowed, and is not retried in a loop', async () => {
  localStorage.setItem(vt.CONSENT_KEY, 'granted');
  const bad = jest.fn(async () => ({ ok: false, status: 503 }));
  expect(await vt.trackVisit({ fetchImpl: bad })).toBe('http_503');
  expect(await vt.trackVisit({ fetchImpl: bad })).toBe('already_sent');
  expect(bad).toHaveBeenCalledTimes(1);
});

test('a corrupted stored id is replaced with a valid one', async () => {
  localStorage.setItem(vt.CONSENT_KEY, 'granted');
  localStorage.setItem(vt.ID_KEY, 'not-a-uuid');
  const f = ok();
  await vt.trackVisit({ fetchImpl: f });
  expect(JSON.parse(f.mock.calls[0][1].body).visitorId).toMatch(UUID);
});
