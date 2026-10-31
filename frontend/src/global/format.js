/**
 * Region-aware formatting + terminology for the Global dashboard.
 * IMPORTANT: the backend stores amounts as plain numbers with no currency or FX rate. These helpers only
 * decide how a number is DISPLAYED; they never convert between currencies.
 */
export const CURRENCIES = [
  { code: 'USD', label: 'US Dollar' }, { code: 'EUR', label: 'Euro' }, { code: 'GBP', label: 'British Pound' },
  { code: 'AED', label: 'UAE Dirham' }, { code: 'SGD', label: 'Singapore Dollar' }, { code: 'AUD', label: 'Australian Dollar' },
  { code: 'CAD', label: 'Canadian Dollar' }, { code: 'CHF', label: 'Swiss Franc' }, { code: 'JPY', label: 'Japanese Yen' },
  { code: 'INR', label: 'Indian Rupee' },
];

const ZERO_DECIMAL = new Set(['JPY']);
// navigator.language can be a POSIX-style tag such as "en-US@posix" (common on Linux), which makes
// Intl throw RangeError and blanks the whole page. Strip modifiers, validate, and fall back.
function safeLocale(tag) {
  try { return Intl.getCanonicalLocales(String(tag || '').replace(/[@.].*$/, '').replace(/_/g, '-'))[0] || 'en-US'; } catch { return 'en-US'; }
}
const userLocale = () => safeLocale(typeof navigator !== 'undefined' ? navigator.language : 'en-US');
// Rupees use lakh/crore grouping (12,34,567); every other currency follows the viewer's own locale.
const localeFor = (currency) => (currency === 'INR' ? 'en-IN' : userLocale());

export function formatMoney(value, currency = 'USD', { compact = false } = {}) {
  const n = Number(value);
  const v = Number.isFinite(n) ? n : 0;
  const useCompact = compact && Math.abs(v) >= 100000;
  try {
    return new Intl.NumberFormat(localeFor(currency), {
      style: 'currency', currency,
      notation: useCompact ? 'compact' : 'standard',
      maximumFractionDigits: ZERO_DECIMAL.has(currency) ? 0 : useCompact ? 1 : 2,
      minimumFractionDigits: ZERO_DECIMAL.has(currency) || useCompact ? 0 : 2,
    }).format(v);
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
}

export const percent = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** 'YYYY-MM-DD' (or ISO timestamp) → locale date, without the off-by-one-day timezone shift. */
export function formatDate(iso, locale = userLocale()) {
  if (!iso) return '—';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat(safeLocale(locale), { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export const TERMS = {
  IN: { region: 'India', tax: 'GST', inputTax: 'Input Tax Credit (ITC)', inputTaxInline: 'input tax credit (ITC)', taxId: 'GSTIN', authority: 'GST Portal' },
  GLOBAL: { region: 'Global', tax: 'VAT / sales tax', inputTax: 'Input tax (VAT / GST)', inputTaxInline: 'input tax (VAT/GST)', taxId: 'Tax ID', authority: 'tax authority portal' },
};

const TYPE_LABELS = {
  TAX_PORTAL_MISMATCH: 'Tax authority mismatch', GST_PORTAL_MISMATCH: 'Tax authority mismatch',
  DUPLICATE_INVOICE: 'Possible duplicate invoice', DUPLICATE_DETECTED: 'Possible duplicate invoice',
  MISSING_INVOICE: 'Missing invoice', MISSING_INVOICE_DETECTED: 'Missing invoice',
  RECONCILIATION_UNMATCHED: 'No matching payment', RECONCILIATION_MANUAL_REVIEW: 'Match needs review',
};
export function humanizeType(type, region = 'GLOBAL') {
  if (region === 'IN' && /MISMATCH/.test(type || '')) return 'GST portal mismatch';
  if (TYPE_LABELS[type]) return TYPE_LABELS[type];
  return String(type || 'Exception').toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export const SEVERITY_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
export const sortBySeverity = (list) => [...list].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));

/** Deterministic board-ready summary built from real numbers (the backend's own narrative is rupee/GST-specific). */
export function executiveSummary({ total, reconciled, openCount, taxAtRisk, recoverable, currency, terms }) {
  if (!total) return 'No documents yet. Upload invoices, bank statements or a spreadsheet to get your first reconciliation overview.';
  const rate = percent(reconciled, total);
  const parts = [`${reconciled} of ${total} documents (${rate}%) were reconciled automatically.`];
  parts.push(openCount === 0 ? 'No exceptions are waiting for review.' : `${openCount} exception${openCount === 1 ? ' needs' : 's need'} review.`);
  if (taxAtRisk > 0) parts.push(`${formatMoney(taxAtRisk, currency)} of ${terms.inputTaxInline} is currently exposed${recoverable > 0 ? `, of which an estimated ${formatMoney(recoverable, currency)} is recoverable` : ''}.`);
  return parts.join(' ');
}
