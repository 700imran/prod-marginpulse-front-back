/** Turnstile on the sign-in form: gating, token hand-off to Supabase, single-use reset. */
let act;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

function mount({ captcha, signIn }) {
  jest.resetModules();
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  act = React.act;
  global.IS_REACT_ACT_ENVIRONMENT = true;

  const widgets = [];
  window.turnstile = {
    render: jest.fn((el, opts) => { widgets.push(opts); return 'w1'; }),
    reset: jest.fn(),
    remove: jest.fn(),
  };
  const signInWithPassword = jest.fn(signIn);
  jest.doMock('./supabaseClient', () => ({ supabase: { auth: { signInWithPassword, signUp: jest.fn(), signInWithOAuth: jest.fn() } } }));
  jest.doMock('./api', () => ({ getPublicConfig: () => Promise.resolve({ captcha }) }));

  const LoginPage = require('./LoginPage').default;
  const el = document.createElement('div');
  document.body.appendChild(el);
  const onSuccess = jest.fn();
  act(() => { createRoot(el).render(React.createElement(LoginPage, { onSuccess })); });
  return { el, widgets, signInWithPassword, onSuccess };
}

function fill(el, id, value) {
  const input = el.querySelector(`#${id}`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  act(() => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const submitBtn = (el) => el.querySelector('form button[type="submit"]'); // not the page-level "Sign In" tab
const submit = (el) => act(async () => { el.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await new Promise((r) => setTimeout(r, 10)); });
const ON = { enabled: true, siteKey: '1x00000000000000000000AA' };

beforeEach(() => { document.body.innerHTML = ''; });

test('captcha ON: widget renders with the backend-provided site key, submit stays disabled until solved', async () => {
  const { el, widgets, signInWithPassword } = mount({ captcha: ON, signIn: () => Promise.resolve({ data: { session: {} }, error: null }) });
  await flush();
  expect(widgets).toHaveLength(1);
  expect(widgets[0].sitekey).toBe(ON.siteKey);
  expect(widgets[0].action).toBe('login');
  fill(el, 'login-email', 'asha@acme.in'); fill(el, 'login-password', 'Str0ng!Pass#2026');
  expect(submitBtn(el).disabled).toBe(true);
  await submit(el); // even a forced submit must not reach Supabase without a token
  expect(signInWithPassword).not.toHaveBeenCalled();
  expect(el.textContent).toMatch(/complete the security check/i);
});

test('captcha ON: solved token is passed to Supabase as captchaToken; success signs in', async () => {
  const { el, widgets, signInWithPassword, onSuccess } = mount({ captcha: ON, signIn: () => Promise.resolve({ data: { session: { access_token: 'a' } }, error: null }) });
  await flush();
  fill(el, 'login-email', 'asha@acme.in'); fill(el, 'login-password', 'Str0ng!Pass#2026');
  act(() => { widgets[0].callback('tok-123'); });
  expect(submitBtn(el).disabled).toBe(false);
  await submit(el);
  expect(signInWithPassword).toHaveBeenCalledTimes(1);
  expect(signInWithPassword.mock.calls[0][0].options).toEqual({ captchaToken: 'tok-123' });
  expect(onSuccess).toHaveBeenCalled();
});

test('failed sign-in resets the widget (tokens are single-use) and re-disables submit', async () => {
  const { el, widgets } = mount({ captcha: ON, signIn: () => Promise.resolve({ data: null, error: { message: 'Invalid login credentials' } }) });
  await flush();
  fill(el, 'login-email', 'asha@acme.in'); fill(el, 'login-password', 'Str0ng!Pass#2026');
  act(() => { widgets[0].callback('tok-1'); });
  await submit(el);
  expect(window.turnstile.reset).toHaveBeenCalled();
  expect(el.textContent).toContain('Invalid login credentials');
  expect(submitBtn(el).disabled).toBe(true); // needs a fresh token
});

test('expired token disables submit again', async () => {
  const { el, widgets } = mount({ captcha: ON, signIn: () => Promise.resolve({ data: { session: {} }, error: null }) });
  await flush();
  act(() => { widgets[0].callback('tok'); });
  expect(submitBtn(el).disabled).toBe(false);
  act(() => { widgets[0]['expired-callback'](); });
  expect(submitBtn(el).disabled).toBe(true);
});

test('captcha OFF: no widget, no captchaToken, login works exactly as before', async () => {
  const { el, signInWithPassword, onSuccess } = mount({ captcha: { enabled: false }, signIn: () => Promise.resolve({ data: { session: {} }, error: null }) });
  await flush();
  expect(window.turnstile.render).not.toHaveBeenCalled();
  fill(el, 'login-email', 'asha@acme.in'); fill(el, 'login-password', 'Str0ng!Pass#2026');
  expect(submitBtn(el).disabled).toBe(false);
  await submit(el);
  expect(signInWithPassword.mock.calls[0][0].options).toBeUndefined();
  expect(onSuccess).toHaveBeenCalled();
});

test('widget load error shows an actionable message instead of a dead form', async () => {
  const { el, widgets } = mount({ captcha: ON, signIn: () => Promise.resolve({ data: null, error: null }) });
  await flush();
  act(() => { widgets[0]['error-callback'](); });
  expect(el.textContent).toMatch(/security check couldn't load/i);
});
