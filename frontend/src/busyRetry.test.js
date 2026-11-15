import { backoffMs, fetchRetryingBusy } from './busyRetry';

const res = (status, body = {}, headers = {}) => ({ status, ok: status < 400, headers: { get: (k) => headers[k] ?? null }, clone() { return this; }, json: async () => body });
const noSleep = () => { const s = jest.fn(async () => {}); return s; };

test('waits at least as long as Retry-After and adds jitter (never earlier, at most +50%)', () => {
  expect(backoffMs(0, '4', () => 0)).toBe(4000);
  expect(backoffMs(0, '4', () => 1)).toBe(6000);
  expect(backoffMs(0, '999', () => 0)).toBe(15000);          // a silly header cannot park the user for minutes
  expect(backoffMs(3, null, () => 0)).toBe(8000);             // no header: exponential, capped
});

test('a BUSY 503 is retried with the server\'s Retry-After until it succeeds, and the successful response is returned', async () => {
  const seq = [res(503, { code: 'BUSY' }, { 'Retry-After': '2' }), res(503, { code: 'BUSY' }, { 'Retry-After': '2' }), res(201, { ok: 1 })];
  const f = jest.fn(async () => seq.shift());
  const sleep = noSleep();
  const out = await fetchRetryingBusy(f, { sleepImpl: sleep, rnd: () => 0 });
  expect(out.status).toBe(201);
  expect(f).toHaveBeenCalledTimes(3);
  expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 2000]);
});

test('writes are NOT retried for an ordinary 503, nor for 402/422/500 — only for {code:"BUSY"}', async () => {
  for (const r of [res(503, { error: 'maintenance' }), res(402, { code: 'PLAN_LIMIT' }), res(422, {}), res(500, {})]) {
    const f = jest.fn(async () => r); const sleep = noSleep();
    expect(await fetchRetryingBusy(f, { sleepImpl: sleep })).toBe(r);
    expect(f).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
  }
});

test('reads retry any 503 and 429', async () => {
  const seq = [res(429, {}, { 'Retry-After': '1' }), res(503, {}), res(200, { items: [] })];
  const f = jest.fn(async () => seq.shift());
  expect((await fetchRetryingBusy(f, { anyGet: true, sleepImpl: noSleep(), rnd: () => 0 })).status).toBe(200);
  expect(f).toHaveBeenCalledTimes(3);
});

test('gives up after the total-wait budget and returns the server\'s own answer for the screen to show', async () => {
  const busy = res(503, { code: 'BUSY', error: 'busy' }, { 'Retry-After': '10' });
  const f = jest.fn(async () => busy);
  const out = await fetchRetryingBusy(f, { maxWaitMs: 25000, sleepImpl: noSleep(), rnd: () => 0 });
  expect(out).toBe(busy);
  expect(f).toHaveBeenCalledTimes(3); // waits of 10 s + 10 s, the third wait would exceed 25 s
});
