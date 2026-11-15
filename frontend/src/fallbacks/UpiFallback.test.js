/** UPI backup payment: hidden when off, manual UTR flow, gateway polling flow, money-safe messaging. */
let React, act, createRoot, api;
const roots = [];
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 15)); });
const PLAN = { id: 'pro', label: 'Pro', price: 1499 };

function mount({ config, orderResp, utrResp, pollResp, forceOpen = false, onPaid = jest.fn() }) {
  jest.resetModules();
  React = require('react'); ({ createRoot } = require('react-dom/client')); act = React.act;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  api = {
    getUpiConfig: jest.fn(async () => config),
    createUpiOrder: jest.fn(async () => orderResp),
    submitUpiUtr: jest.fn(async () => utrResp),
    getUpiOrder: jest.fn(async () => (typeof pollResp === 'function' ? pollResp() : pollResp)),
  };
  jest.doMock('./fallbackApi', () => api);
  const UpiFallback = require('./UpiFallback').default;
  const el = document.createElement('div'); document.body.appendChild(el);
  const root = createRoot(el); roots.push(root);
  act(() => { root.render(React.createElement(UpiFallback, { plan: PLAN, onPaid, forceOpen, pollMs: 20 })); });
  return { el, onPaid };
}
const btn = (el, re) => [...el.querySelectorAll('button, a')].find((b) => re.test(b.textContent));
const click = (el, re) => act(async () => { btn(el, re).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const type = (input, v) => act(async () => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, v);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
afterEach(() => { while (roots.length) { const r = roots.pop(); act(() => r.unmount()); } document.body.innerHTML = ''; });

const MANUAL = { ok: true, status: 201, data: { paymentId: 'p1', plan: 'pro', amountInr: 1499, reference: 'MP123ABC', mode: 'manual', status: 'PENDING', vpa: 'pay@bank', payeeName: 'MarginPulse', upiIntent: 'upi://pay?pa=pay@bank&am=1499' } };

test('renders nothing when the server has the UPI backup off (the normal case)', async () => {
  const { el } = mount({ config: { ok: true, data: { enabled: false, mode: null } } });
  await flush();
  expect(el.textContent).toBe('');
});

test('renders nothing when the config call fails — the card flow is never disturbed', async () => {
  const { el } = mount({ config: { ok: false, status: 0, data: { error: 'offline' } } });
  await flush();
  expect(el.textContent).toBe('');
});

test('manual mode: create order → show UPI ID + reference → UTR must be 12 digits → submit → waits for confirmation', async () => {
  const { el } = mount({ config: { ok: true, data: { enabled: true, mode: 'manual' } }, orderResp: MANUAL, utrResp: { ok: true, data: { status: 'SUBMITTED', message: 'Thanks — we will confirm.' } }, pollResp: { ok: true, data: { status: 'SUBMITTED' } } });
  await flush();
  await click(el, /Pay via UPI \(backup\)/);
  await click(el, /Pay ₹1499 via UPI/);
  expect(api.createUpiOrder).toHaveBeenCalledWith('pro');          // only the plan id goes to the server
  expect(el.textContent).toContain('pay@bank');
  expect(el.textContent).toContain('MP123ABC');
  expect(el.querySelector('a[href^="upi://"]')).toBeTruthy();
  const submit = () => btn(el, /Submit UTR/);
  expect(submit().disabled).toBe(true);
  await type(el.querySelector('input'), '12345');
  expect(submit().disabled).toBe(true);
  await type(el.querySelector('input'), '12ab3456789012x'); // non-digits are stripped, max 12
  expect(el.querySelector('input').value).toBe('123456789012');
  await click(el, /Submit UTR/);
  expect(api.submitUpiUtr).toHaveBeenCalledWith('p1', '123456789012');
  expect(el.textContent).toContain('UTR received');
});

test('a server refusal is shown in plain words (e.g. UTR already used) and nothing is claimed as paid', async () => {
  const { el, onPaid } = mount({ config: { ok: true, data: { enabled: true, mode: 'manual' } }, orderResp: MANUAL, utrResp: { ok: false, status: 409, data: { error: 'That UTR has already been used for another payment' } } });
  await flush();
  await click(el, /Pay via UPI \(backup\)/); await click(el, /Pay ₹1499 via UPI/);
  await type(el.querySelector('input'), '123456789012'); await click(el, /Submit UTR/);
  expect(el.querySelector('[role="alert"]').textContent).toContain('already been used');
  expect(onPaid).not.toHaveBeenCalled();
});

test('gateway mode: shows the payment page link, polls, and activates the plan exactly once when PAID', async () => {
  let calls = 0;
  const { el, onPaid } = mount({
    config: { ok: true, data: { enabled: true, mode: 'gateway' } },
    orderResp: { ok: true, status: 201, data: { paymentId: 'g1', plan: 'pro', amountInr: 1499, reference: 'MPG1', mode: 'gateway', status: 'PENDING', paymentUrl: 'https://pay.example.test/o/1', upiIntent: 'upi://pay?x=1' } },
    pollResp: () => ({ ok: true, data: { status: ++calls < 3 ? 'PENDING' : 'PAID' } }),
  });
  await flush();
  await click(el, /Pay via UPI \(backup\)/); await click(el, /Pay ₹1499 via UPI/);
  expect(el.querySelector('a[href="https://pay.example.test/o/1"]').getAttribute('rel')).toContain('noopener');
  expect(el.textContent).toContain('Waiting for your payment');
  await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
  expect(el.textContent).toContain('your plan is now active');
  expect(onPaid).toHaveBeenCalledTimes(1);
  const seen = api.getUpiOrder.mock.calls.length;
  await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
  expect(api.getUpiOrder.mock.calls.length).toBe(seen);          // polling stopped once final
});

test('an expired order says so, is not applied, and offers a fresh start', async () => {
  const { el, onPaid } = mount({
    config: { ok: true, data: { enabled: true, mode: 'gateway' } },
    orderResp: { ok: true, status: 201, data: { paymentId: 'g2', amountInr: 1499, reference: 'MPG2', mode: 'gateway', status: 'PENDING', paymentUrl: 'https://pay.example.test/o/2' } },
    pollResp: { ok: true, data: { status: 'EXPIRED' } },
  });
  await flush();
  await click(el, /Pay via UPI \(backup\)/); await click(el, /Pay ₹1499 via UPI/);
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  expect(el.querySelector('[role="alert"]').textContent).toContain('expired');
  expect(btn(el, /Start a new UPI payment/)).toBeTruthy();
  expect(onPaid).not.toHaveBeenCalled();
});

test('opens by itself when the card payment just failed (forceOpen)', async () => {
  const { el } = mount({ config: { ok: true, data: { enabled: true, mode: 'manual' } }, forceOpen: true });
  await flush();
  expect(btn(el, /Pay ₹1499 via UPI/)).toBeTruthy();
});

test('429 / gateway-down errors on create are shown, not swallowed', async () => {
  const { el } = mount({ config: { ok: true, data: { enabled: true, mode: 'gateway' } }, orderResp: { ok: false, status: 502, data: { error: 'The UPI gateway is not reachable right now. You have not been charged — please try again in a minute.' } } });
  await flush();
  await click(el, /Pay via UPI \(backup\)/); await click(el, /Pay ₹1499 via UPI/);
  expect(el.querySelector('[role="alert"]').textContent).toContain('not been charged');
});
