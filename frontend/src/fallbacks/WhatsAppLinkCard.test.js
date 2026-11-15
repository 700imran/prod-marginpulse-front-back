/** WhatsApp link card: hidden when off; code flow; polls until the number is bound; unlink. */
let React, act, createRoot, api;
const roots = [];
const flush = (ms = 15) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
function mount(overrides) {
  jest.resetModules();
  React = require('react'); ({ createRoot } = require('react-dom/client')); act = React.act;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  api = { getWhatsAppLink: jest.fn(), createWhatsAppLinkCode: jest.fn(), unlinkWhatsApp: jest.fn(), ...overrides };
  jest.doMock('./fallbackApi', () => api);
  const Card = require('./WhatsAppLinkCard').default;
  const el = document.createElement('div'); document.body.appendChild(el);
  const root = createRoot(el); roots.push(root);
  const onToast = jest.fn();
  act(() => { root.render(React.createElement(Card, { pollMs: 20, onToast })); });
  return { el, onToast };
}
const btn = (el, re) => [...el.querySelectorAll('button')].find((b) => re.test(b.textContent));
const click = (el, re) => act(async () => { btn(el, re).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
afterEach(() => { while (roots.length) { const r = roots.pop(); act(() => r.unmount()); } document.body.innerHTML = ''; });

test('hidden when the gateway is not enabled on the server', async () => {
  const { el } = mount({ getWhatsAppLink: jest.fn(async () => ({ ok: true, data: { gatewayEnabled: false, boundPhone: null } })) });
  await flush();
  expect(el.textContent).toBe('');
});

test('link flow: shows the exact LINK message, then flips to "linked" by itself when the number is bound', async () => {
  let bound = null;
  const { el, onToast } = mount({
    getWhatsAppLink: jest.fn(async () => ({ ok: true, data: { gatewayEnabled: true, gatewayNumber: '+91 90000 00000', boundPhone: bound } })),
    createWhatsAppLinkCode: jest.fn(async () => ({ ok: true, data: { code: '123456', expiresInMinutes: 10, sendTo: '+91 90000 00000', message: 'LINK 123456' } })),
  });
  await flush();
  expect(el.textContent).toContain('Link my WhatsApp number');
  await click(el, /Link my WhatsApp number/);
  expect(el.textContent).toContain('LINK 123456');
  expect(el.textContent).toContain('+91 90000 00000');
  bound = '+91 ••••• ••210';
  await flush(80);
  expect(el.textContent).toContain('Linked number');
  expect(el.textContent).toContain('••210');
  expect(onToast).toHaveBeenCalledWith('WhatsApp number linked', 'success');
  expect(el.textContent).not.toContain('LINK 123456');
});

test('rate-limited code request shows a clear message', async () => {
  const { el } = mount({
    getWhatsAppLink: jest.fn(async () => ({ ok: true, data: { gatewayEnabled: true, boundPhone: null } })),
    createWhatsAppLinkCode: jest.fn(async () => ({ ok: false, status: 429, data: { error: 'rate limited' } })),
  });
  await flush();
  await click(el, /Link my WhatsApp number/);
  expect(el.querySelector('[role="alert"]').textContent).toContain('Too many attempts');
});

test('unlink removes the number from the screen', async () => {
  const { el } = mount({
    getWhatsAppLink: jest.fn(async () => ({ ok: true, data: { gatewayEnabled: true, boundPhone: '+91 ••••• ••210' } })),
    unlinkWhatsApp: jest.fn(async () => ({ ok: true, data: { boundPhone: null } })),
  });
  await flush();
  await click(el, /Unlink/);
  expect(api.unlinkWhatsApp).toHaveBeenCalled();
  expect(el.textContent).toContain('Link my WhatsApp number');
});
