/** The Pay button must never be silent: every failure ends in a clear message within the timeout. */
function load({ api = 'https://api.example.test', fetchImpl } = {}) {
  jest.resetModules();
  document.body.innerHTML = '';
  delete window.Razorpay;
  if (api) process.env.REACT_APP_API_URL = api; else delete process.env.REACT_APP_API_URL;
  jest.doMock('../security/tokenManager', () => ({ tokenManager: { getValidAccessToken: jest.fn(() => Promise.resolve('tok-1')) } }));
  global.fetch = jest.fn(fetchImpl || (() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })));
  const mod = require('./razorpay');
  const net = require('../net');
  net.TIMEOUTS.script = 60; net.TIMEOUTS.order = 60; net.TIMEOUTS.verify = 60;   // keep tests fast
  const events = [];
  return { ...mod, events, onStatus: (s) => events.push(s), last: () => events[events.length - 1] };
}
const json = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const hangUntilAbort = (_u, init) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));

function stubRazorpay() {
  const inst = { opts: null, handlers: {}, opened: 0 };
  window.Razorpay = function (opts) { inst.opts = opts; return { on: (e, cb) => { inst.handlers[e] = cb; }, open: () => { inst.opened++; } }; };
  return inst;
}
const scriptEl = () => document.getElementById('razorpay-checkout-script');

test('REGRESSION: after one failed script load, the next click really retries instead of hanging forever', async () => {
  const { loadRazorpayScript } = load();
  const first = loadRazorpayScript();
  scriptEl().dispatchEvent(new Event('error'));                       // blocked / network failure
  await expect(first).rejects.toThrow(/could not be loaded/);
  expect(scriptEl()).toBeNull();                                      // stale element removed

  const second = loadRazorpayScript();                                // user clicks again
  expect(scriptEl()).not.toBeNull();                                  // a NEW script was requested
  window.Razorpay = function () {};
  scriptEl().dispatchEvent(new Event('load'));
  await expect(second).resolves.toBeUndefined();
});

test('a script that never loads times out with a clear message (no infinite wait)', async () => {
  const { startPayment, onStatus, last } = load();
  await startPayment('pro', { onStatus });
  expect(last().stage).toBe('error');
  expect(last().message).toMatch(/took too long to load/);
  expect(last().message).toMatch(/not been charged/);
});

test('blocked script (ad-blocker / CSP) explains what to do', async () => {
  const { startPayment, onStatus, last } = load();
  const p = startPayment('pro', { onStatus });
  await new Promise((r) => setTimeout(r, 5));
  scriptEl().dispatchEvent(new Event('error'));
  await p;
  expect(last().message).toMatch(/disable ad\/tracker blockers/i);
});

test('server not answering: create-order times out with a clear message', async () => {
  const { startPayment, onStatus, last } = load({ fetchImpl: hangUntilAbort });
  stubRazorpay();
  await startPayment('pro', { onStatus });
  expect(last().stage).toBe('error');
  expect(last().message).toMatch(/took too long to respond/);
});

test('happy path: sends only the plan (never an amount), opens Razorpay, confirms, reports success', async () => {
  const calls = [];
  const { startPayment, onStatus, events, last } = load({ fetchImpl: (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/create-order') ? json({ orderId: 'order_1', keyId: 'rzp_test_x', amount: 1499 }) : json({ status: 'verified', planTier: 'GROWTH' });
  } });
  const rz = stubRazorpay();
  await startPayment('pro', { onStatus });

  expect(calls[0].url).toBe('https://api.example.test/api/v1/billing/create-order');   // configured base, not a hard-coded host
  expect(JSON.parse(calls[0].init.body)).toEqual({ plan: 'pro' });
  expect(calls[0].init.headers.Authorization).toBe('Bearer tok-1');
  expect(rz.opened).toBe(1); expect(rz.opts.order_id).toBe('order_1'); expect(rz.opts.key).toBe('rzp_test_x');
  expect(events.map((e) => e.stage)).toEqual(['preparing', 'awaiting']);

  await rz.opts.handler({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'sig' });
  await new Promise((r) => setTimeout(r, 5));
  expect(calls[1].url).toBe('https://api.example.test/api/v1/billing/verify-payment');
  expect(JSON.parse(calls[1].init.body)).toEqual({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: 'sig' });
  expect(last().stage).toBe('success'); expect(last().planTier).toBe('GROWTH');
});

test('server errors are shown as-is; rate limit gets a friendly message', async () => {
  let r = load({ fetchImpl: () => json({ error: 'plan must be one of: starter, pro, enterprise' }, 400) });
  stubRazorpay(); await r.startPayment('pro', { onStatus: r.onStatus });
  expect(r.last().message).toMatch(/plan must be one of/); expect(r.last().message).toMatch(/not been charged/);
  r = load({ fetchImpl: () => json({ error: 'rate limit exceeded' }, 429) });
  stubRazorpay(); await r.startPayment('pro', { onStatus: r.onStatus });
  expect(r.last().message).toMatch(/wait a minute/);
});

test('closing the payment window or a declined payment resets cleanly with reassurance', async () => {
  const { startPayment, onStatus, last } = load({ fetchImpl: () => json({ orderId: 'o', keyId: 'k' }) });
  const rz = stubRazorpay();
  await startPayment('pro', { onStatus });
  rz.opts.modal.ondismiss();
  expect(last().stage).toBe('idle'); expect(last().message).toMatch(/not been charged/);
  rz.handlers['payment.failed']({ error: { description: 'Card declined' } });
  expect(last().stage).toBe('error'); expect(last().message).toContain('Card declined');
});

test('if confirmation fails after paying, the user can retry WITHOUT paying again (no second order)', async () => {
  let verifyCalls = 0; const urls = [];
  const { startPayment, retryVerification, onStatus, last } = load({ fetchImpl: (url) => {
    urls.push(url);
    if (url.endsWith('/create-order')) return json({ orderId: 'order_1', keyId: 'k' });
    verifyCalls++; return verifyCalls === 1 ? Promise.reject(new TypeError('Failed to fetch')) : json({ status: 'verified', planTier: 'GROWTH' });
  } });
  const rz = stubRazorpay();
  await startPayment('pro', { onStatus });
  await rz.opts.handler({ razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_9', razorpay_signature: 's' });
  await new Promise((r) => setTimeout(r, 5));
  expect(last().stage).toBe('error'); expect(last().retry).toBe(true);
  expect(last().message).toContain('pay_9'); expect(last().message).toMatch(/safe/);

  await retryVerification({ onStatus });
  expect(last().stage).toBe('success');
  expect(urls.filter((u) => u.endsWith('/create-order'))).toHaveLength(1);    // no second order was created
});
