let act;
test('Upgrade button shows live status, is disabled while working, and never uses alert()', async () => {
  jest.resetModules();
  const React = require('react'); const { createRoot } = require('react-dom/client'); act = React.act;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  window.alert = jest.fn(() => { throw new Error('alert() must not be used'); });
  let release;
  jest.doMock('../payments/razorpay', () => ({
    loadRazorpayScript: () => Promise.resolve(), retryVerification: jest.fn(),
    startPayment: (plan, { onStatus }) => new Promise((res) => { onStatus({ stage: 'preparing', message: 'Contacting the payment gateway…' }); release = () => { onStatus({ stage: 'error', message: 'Could not start the payment. You have not been charged.' }); res(); }; }),
  }));
  jest.doMock('../api', () => ({ clearDataCache: jest.fn() }));
  const View = require('./BillingView').default;
  const el = document.createElement('div'); document.body.appendChild(el);
  act(() => { createRoot(el).render(React.createElement(View, { tenant: { planTier: 'FREE' } })); });
  const btn = () => [...el.querySelectorAll('button')].find((b) => /Upgrade to|Opening secure|Confirming|Complete payment/.test(b.textContent));
  expect(btn().textContent).toContain('Upgrade to Pro — ₹1499');
  await act(async () => { btn().dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(btn().disabled).toBe(true);
  expect(btn().textContent).toContain('Opening secure payment');
  expect(el.querySelector('[role="status"]').textContent).toContain('Contacting the payment gateway');
  await act(async () => { release(); });
  expect(el.querySelector('[role="alert"]').textContent).toContain('You have not been charged');
  expect(btn().disabled).toBe(false);                         // the user can try again
  expect(window.alert).not.toHaveBeenCalled();
  expect(el.textContent).not.toContain('api.marginpulse.in');  // no hard-coded host in the UI
});
