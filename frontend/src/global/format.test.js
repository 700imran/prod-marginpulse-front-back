import { formatMoney, formatDate, percent, humanizeType, sortBySeverity, executiveSummary, TERMS } from './format';
import { getRegion, setRegion, getCurrency, setCurrency } from './region';

beforeEach(() => localStorage.clear());

test('currencies format correctly: symbols, decimals, rupee lakh grouping, yen without decimals', () => {
  expect(formatMoney(1234567.5, 'USD')).toMatch(/\$1,234,567\.50|\$1\.234\.567,50/);
  expect(formatMoney(1234567.5, 'INR')).toBe('₹12,34,567.50');           // lakh/crore grouping for rupees
  expect(formatMoney(1500, 'JPY')).toMatch(/¥1,500|JP¥1,500|￥1,500/);   // no decimals
  expect(formatMoney(2500000, 'USD', { compact: true })).toMatch(/\$2\.5M/);
  expect(formatMoney(999, 'USD', { compact: true })).toMatch(/\$999\.00/); // small numbers are never abbreviated
});

test('bad input never throws or shows NaN', () => {
  expect(formatMoney(undefined, 'USD')).toMatch(/0\.00/);
  expect(formatMoney('abc', 'EUR')).toMatch(/0[.,]00/);
  expect(formatMoney(5, 'NOT_A_CURRENCY')).toBe('NOT_A_CURRENCY 5.00');
  expect(formatDate(null)).toBe('—');
  expect(formatDate('garbage')).toBe('—');
});

test('dates do not shift a day with timezones', () => {
  expect(formatDate('2026-03-05', 'en-GB')).toBe('5 Mar 2026');
  expect(formatDate('2026-03-05T23:30:00Z', 'en-GB')).toBe('5 Mar 2026');
});

test('percent, severity ordering, readable exception names', () => {
  expect(percent(3, 4)).toBe(75); expect(percent(1, 0)).toBe(0);
  expect(sortBySeverity([{ severity: 'LOW' }, { severity: 'CRITICAL' }, { severity: 'HIGH' }, { severity: 'WEIRD' }]).map((x) => x.severity)).toEqual(['CRITICAL', 'HIGH', 'LOW', 'WEIRD']);
  expect(humanizeType('TAX_PORTAL_MISMATCH', 'GLOBAL')).toBe('Tax authority mismatch');
  expect(humanizeType('TAX_PORTAL_MISMATCH', 'IN')).toBe('GST portal mismatch');
  expect(humanizeType('SOMETHING_NEW')).toBe('Something new');
});

test('executive summary is built from real numbers, plural-correct, and region-worded', () => {
  const base = { total: 40, reconciled: 30, openCount: 1, taxAtRisk: 0, recoverable: 0, currency: 'USD', terms: TERMS.GLOBAL };
  expect(executiveSummary(base)).toBe('30 of 40 documents (75%) were reconciled automatically. 1 exception needs review.');
  expect(executiveSummary({ ...base, openCount: 0 })).toContain('No exceptions are waiting');
  const s = executiveSummary({ ...base, openCount: 3, taxAtRisk: 12000, recoverable: 9000 });
  expect(s).toContain('3 exceptions need review');
  expect(s).toContain('of input tax (VAT/GST) is currently exposed');
  expect(s).not.toMatch(/₹|GST Portal/);
  expect(executiveSummary({ ...base, total: 0 })).toMatch(/No documents yet/);
});

test('region defaults from the account country, honours the saved choice, and picks a sensible currency', () => {
  expect(getRegion({ countryCode: 'IN' })).toBe('IN');
  expect(getRegion({ countryCode: 'AE' })).toBe('GLOBAL');
  expect(getRegion({})).toBe('IN');
  expect(getCurrency('IN')).toBe('INR'); expect(getCurrency('GLOBAL')).toBe('USD');
  setRegion('GLOBAL'); setCurrency('EUR');
  expect(getRegion({ countryCode: 'IN' })).toBe('GLOBAL');
  expect(getCurrency('IN')).toBe('EUR');
});

test('a POSIX-style browser locale ("en-US@posix") no longer crashes date or money formatting', () => {
  const real = Object.getOwnPropertyDescriptor(Navigator.prototype, 'language');
  for (const tag of ['en-US@posix', 'C', 'en_GB.UTF-8', '', 'not a locale!!']) {
    Object.defineProperty(navigator, 'language', { value: tag, configurable: true });
    expect(() => formatDate('2026-03-05')).not.toThrow();
    expect(formatDate('2026-03-05')).toMatch(/2026/);
    expect(formatMoney(1234.5, 'USD')).toMatch(/1,234\.50|1\.234,50/);
  }
  delete navigator.language;
  if (real) Object.defineProperty(Navigator.prototype, 'language', real);
});
