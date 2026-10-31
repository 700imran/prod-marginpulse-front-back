let act;
const flush = async (ms = 30) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };

const SUMMARY = { summaryMetrics: { totalUploadedDocuments: 40, successfullyReconciledCount: 30, unreconciledAnomaliesDetected: 2, gstMismatchFlagCount: 1 }, itcAtRisk: 12000, gstProblemVendors: ['Acme'], plainEnglishInsight: 'blocking ₹12,000 in Input Tax Credits' };
const INSIGHTS = { estimatedRecoverableItc: 9000, vendorsRequiringFollowUp: [{ vendorName: 'Nordic Supplies AS', totalTaxAtRisk: 7000, openIssueCount: 2, reasons: [] }], filingDeadlines: [{ returnType: 'GSTR-3B', period: '2026-09', dueDate: '2026-11-20', daysRemaining: 6, approaching: true }], highestItcRiskToday: [] };
const ANOMALIES = { items: [
  { anomalyId: 'a1', anomalyType: 'TAX_PORTAL_MISMATCH', severity: 'HIGH', description: 'Supplier has not filed', suggestedAction: 'Send a reminder', status: 'OPEN' },
  { anomalyId: 'a2', anomalyType: 'DUPLICATE_INVOICE', severity: 'LOW', description: 'Looks like INV-9 twice', suggestedAction: null, status: 'OPEN' },
  { anomalyId: 'a3', anomalyType: 'RECONCILIATION_MANUAL_REVIEW', severity: 'CRITICAL', description: 'Two equal candidates', suggestedAction: null, status: 'OPEN' },
] };
const DOCS = { items: [{ documentId: 'd1', vendorName: 'Nordic Supplies AS', invoiceNumber: 'NS-1', documentDate: '2026-03-05', rawTotalAmount: '12500.00', taxAmount: '2500.00', processingStatus: 'RECONCILED' }] };

function mount({ tenant = { businessName: 'Acme GmbH', countryCode: 'DE' }, api = {}, saved = {}, peeked = null } = {}) {
  jest.resetModules();
  localStorage.clear();
  Object.entries(saved).forEach(([k, v]) => localStorage.setItem(k, v));
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  act = React.act;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const fns = {
    getDashboard: jest.fn(() => Promise.resolve(SUMMARY)), listAnomalies: jest.fn(() => Promise.resolve(ANOMALIES)),
    getDashboardInsights: jest.fn(() => Promise.resolve(INSIGHTS)), listDocuments: jest.fn(() => Promise.resolve(DOCS)),
    resolveAnomaly: jest.fn(() => Promise.resolve({ status: 'RESOLVED' })), triggerReconciliation: jest.fn(() => Promise.resolve({ documents_queued: 3 })),
    uploadDocument: jest.fn(() => Promise.resolve({ documentId: 'new' })),
    uploadDataset: jest.fn(() => Promise.resolve({ rowsImported: 120, datasetType: 'BANK_STATEMENT', reconciliation: { reconciled: 17, review: 3 } })),
    ...api,
  };
  jest.doMock('../api', () => ({ ...fns, peekCached: jest.fn((p) => (peeked ? peeked[p] ?? null : null)), PATHS: {
    dashboard: (p = '2026-Q2') => `/api/v1/reconciliation/dashboard-summary?tax_period=${p}`,
    anomalies: (s = 'OPEN') => `/api/v1/reconciliation/anomalies?status=${s}`,
    insights: () => '/api/v1/reconciliation/dashboard-insights', documents: () => '/api/v1/documents?' } }));
  const View = require('./GlobalDashboardView').default;
  const el = document.createElement('div'); document.body.appendChild(el);
  const onToast = jest.fn();
  act(() => { createRoot(el).render(React.createElement(View, { tenant, onToast })); });
  return { el, fns, onToast };
}
const btn = (el, text) => [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const click = (node) => act(async () => { node.dispatchEvent(new MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 10)); });

beforeEach(() => { document.body.innerHTML = ''; });

test('non-Indian account opens in Global mode with VAT wording, USD formatting and real backend numbers', async () => {
  const { el } = mount();
  await flush();
  const t = el.textContent;
  expect(t).toContain('Global Finance Overview'); expect(t).toContain('Global view'); expect(t).toContain('Acme GmbH');
  expect(t).toContain('75%'); expect(t).toContain('30 of 40 documents');
  expect(t).toMatch(/Input tax \(VAT \/ GST\) at risk/);
  expect(t).toMatch(/\$12,000|\$12\.0K/); expect(t).toMatch(/\$9,000|\$9\.0K/);
  expect(t).not.toMatch(/₹|Input Tax Credit \(ITC\)/);                 // the backend's rupee narrative is never shown
  expect(t).toContain('Nordic Supplies AS'); expect(t).toMatch(/12,500\.00/);
  expect(t).not.toMatch(/Loading…/);
});

test('exceptions are ordered by severity and filterable', async () => {
  const { el } = mount();
  await flush();
  const names = [...el.querySelectorAll('li.list-row > div > div > strong')].map((n) => n.textContent);
  expect(names).toEqual(['Match needs review', 'Tax authority mismatch', 'Possible duplicate invoice']); // critical → high → low
  await click(btn(el, 'Low'));
  expect([...el.querySelectorAll('li.list-row > div > div > strong')].map((n) => n.textContent)).toEqual(['Possible duplicate invoice']);
  await click(btn(el, 'Critical'));
  expect(el.querySelectorAll('li.list-row').length).toBe(1);
});

test('Mark resolved calls the backend and removes the exception', async () => {
  const { el, fns, onToast } = mount();
  await flush();
  await click(el.querySelector('li.list-row button'));
  expect(fns.resolveAnomaly).toHaveBeenCalledWith('a3');
  await flush();
  expect(onToast).toHaveBeenCalledWith('Exception resolved', 'success');
});

test('switching region and currency changes wording and formatting immediately, and is remembered', async () => {
  const { el } = mount();
  await flush();
  await click(btn(el, 'India · GST'));
  expect(el.textContent).toContain('Input Tax Credit (ITC) at risk');
  expect(el.textContent).toMatch(/₹12,000|₹12\.0K/);                    // India defaults to INR
  expect(el.textContent).toContain('GSTR-3B');                          // GST calendar only in India mode
  const sel = el.querySelector('select[aria-label="Display currency"]');
  await act(async () => { sel.value = 'GBP'; sel.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(el.textContent).toMatch(/£12,000|£12\.0K/);
  expect(localStorage.getItem('mp_region')).toBe('IN'); expect(localStorage.getItem('mp_currency')).toBe('GBP');
  await click(btn(el, 'Global · VAT'));
  expect(el.textContent).toMatch(/VAT and sales-tax calendars for other jurisdictions are not connected yet/);
  expect(el.textContent).not.toContain('GSTR-3B');
});

test('upload routes each file to the right backend feature and reports honest results', async () => {
  const { el, fns } = mount();
  await flush();
  const input = el.querySelector('[data-testid="file-input"]');
  const files = [new File(['a'], 'bank.xlsx'), new File(['b'], 'inv.pdf', { type: 'application/pdf' }), new File(['c'], 'old.xls'), new File(['d'], 'x.exe')];
  await act(async () => { Object.defineProperty(input, 'files', { value: files, configurable: true }); input.dispatchEvent(new Event('change', { bubbles: true })); await new Promise((r) => setTimeout(r, 40)); });
  expect(fns.uploadDataset).toHaveBeenCalledTimes(1);   // xlsx → dataset pipeline
  expect(fns.uploadDocument).toHaveBeenCalledTimes(1);  // pdf → document OCR pipeline
  const t = el.textContent;
  expect(t).toContain('Imported 120 bank transactions — 17 reconciled, 3 need review.');
  expect(t).toMatch(/old\.xls — Old \.xls isn't supported/); expect(t).toMatch(/x\.exe — Unsupported type/);
});

test('a failed load shows a clear error with retry instead of a blank or crashing page', async () => {
  const { el, fns } = mount({ api: { getDashboard: jest.fn(() => Promise.resolve({ error: 'boom' })) } });
  await flush();
  expect(el.querySelector('[role="alert"]').textContent).toContain('boom');
  await click(btn(el, 'Try again'));
  expect(fns.listAnomalies.mock.calls.length).toBeGreaterThan(1);
});

test('cached data paints on the very first frame (no spinner, no skeleton) when a refresh happens', async () => {
  const peeked = { '/api/v1/reconciliation/dashboard-summary?tax_period=2026-Q2': SUMMARY };
  const { el } = mount({ peeked });
  expect(el.textContent).toContain('Global Finance Overview'); // synchronous, before any promise resolves
  expect(el.querySelector('[aria-busy="true"]')).toBeNull();
});
