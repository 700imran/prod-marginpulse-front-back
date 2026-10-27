global.IS_REACT_ACT_ENVIRONMENT = true;

let act;
function mountApp({ session, profile, hint }) {
  jest.resetModules();
  // React must come from the SAME module registry as App, or hooks break (two React copies).
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  act = React.act;
  localStorage.clear(); sessionStorage.clear();
  process.env.REACT_APP_SUPABASE_URL = 'https://testproj.supabase.co';
  localStorage.setItem('sb-testproj-auth-token', JSON.stringify(session));
  if (hint) localStorage.setItem('mp_identity', JSON.stringify(hint));
  jest.doMock('./supabaseClient', () => ({ supabase: { auth: { getSession: () => Promise.resolve({ data: { session } }), onAuthStateChange: jest.fn(), refreshSession: jest.fn(), signOut: jest.fn(() => Promise.resolve()) } } }));
  jest.doMock('./api', () => ({
    isLoggedIn: () => true, logout: jest.fn(), prefetchAppData: jest.fn(),
    getProfile: () => new Promise((r) => setTimeout(() => r(profile), 300)), // slow API
  }));
  jest.doMock('./LoginPage', () => () => null);
  ['Dashboard', 'Documents', 'GSTSync', 'Profile', 'TaxBank', 'ReconciliationRules', 'Integrations', 'Notifications', 'Security', 'Billing', 'Team', 'AdminPanel', 'ROICalculator', 'AuditLog']
    .forEach((n) => jest.doMock(`./components/${n}View`, () => ({ __esModule: true, default: () => require('react').createElement('div', null, n + ' screen') })));
  const App = require('./App').default;
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => { root.render(<App />); });
  return { el, root };
}

const session = { access_token: 't', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'u1', email: 'asha@acme.in', user_metadata: { full_name: 'Asha Rao' } } };
const profile = { tenantId: 'u1', ownerEmail: 'asha@acme.in', businessName: 'Acme Traders', displayName: null, planTier: 'GROWTH', isPlatformAdmin: false };

test('first-ever visit: header shows the signed-in user name immediately, never "Loading…"', async () => {
  const { el } = mountApp({ session, profile });
  const header = el.querySelector('.user-profile').textContent;
  expect(header).toContain('Asha Rao');
  expect(el.textContent).not.toMatch(/Loading…/);
});

test('refresh: header shows the organisation/name from the saved identity instantly, before the API answers', async () => {
  const { el } = mountApp({ session, profile, hint: { tenantId: 'u1', displayName: null, businessName: 'Acme Traders', ownerEmail: 'asha@acme.in', planTier: 'GROWTH' } });
  expect(el.querySelector('.user-profile').textContent).toContain('Acme Traders');
  expect(el.querySelector('.avatar').textContent).toBe('AT');
});

test("another user's saved identity is never shown", async () => {
  const { el } = mountApp({ session, profile, hint: { tenantId: 'someone-else', businessName: 'Other Co' } });
  expect(el.textContent).not.toContain('Other Co');
});

test('once the API answers, the display name (if set) wins and is saved for the next refresh', async () => {
  const { el } = mountApp({ session, profile: { ...profile, displayName: 'Asha R.' } });
  await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
  expect(el.querySelector('.user-profile').textContent).toContain('Asha R.');
  expect(JSON.parse(localStorage.getItem('mp_identity')).displayName).toBe('Asha R.');
});
