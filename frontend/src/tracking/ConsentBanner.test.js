/** The banner asks once, respects the answer, and stays out of the way when the browser already said "don't track". */
let React, act, createRoot;
const roots = [];
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 10)); });
function mount() {
  jest.resetModules();
  React = require('react'); ({ createRoot } = require('react-dom/client')); act = React.act;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const ConsentBanner = require('./ConsentBanner').default;
  const el = document.createElement('div'); document.body.appendChild(el);
  const root = createRoot(el); roots.push(root);
  act(() => { root.render(React.createElement(ConsentBanner)); });
  return el;
}
const click = (el, text) => act(async () => { [...el.querySelectorAll('button')].find((b) => b.textContent === text).dispatchEvent(new MouseEvent('click', { bubbles: true })); });

afterEach(() => { while (roots.length) { const r = roots.pop(); act(() => r.unmount()); } }); // old roots must not keep listening on window

beforeEach(() => {
  document.body.innerHTML = ''; localStorage.clear(); sessionStorage.clear();
  Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true });
  Object.defineProperty(navigator, 'globalPrivacyControl', { value: undefined, configurable: true });
  global.fetch = jest.fn(async () => ({ ok: true, status: 202 }));
});

test('shows when undecided; "Accept" hides it and counts the visit once', async () => {
  const el = mount(); await flush();
  expect(el.textContent).toMatch(/count your visit/);
  expect(global.fetch).not.toHaveBeenCalled();
  await click(el, 'Accept'); await flush();
  expect(el.textContent).toBe('');
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][0]).toBe('/api/v1/track/visit');
});

test('"No thanks" hides it and sends nothing (no id was ever created)', async () => {
  const el = mount(); await flush();
  await click(el, 'No thanks'); await flush();
  expect(el.textContent).toBe('');
  expect(global.fetch).not.toHaveBeenCalled();
  expect(localStorage.getItem('mp_visitor_id')).toBeNull();
});

test('an earlier "granted" decision is not asked again, and the new session is still counted', async () => {
  localStorage.setItem('mp_track_consent', 'granted');
  const el = mount(); await flush();
  expect(el.textContent).toBe('');
  expect(global.fetch).toHaveBeenCalledTimes(1);
});

test('Do-Not-Track: no banner, no request', async () => {
  Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
  const el = mount(); await flush();
  expect(el.textContent).toBe('');
  expect(global.fetch).not.toHaveBeenCalled();
});
