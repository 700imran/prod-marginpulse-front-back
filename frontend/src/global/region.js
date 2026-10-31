// Remembers the viewer's region and display currency in this browser.
const REGION_KEY = 'mp_region';
const CURRENCY_KEY = 'mp_currency';
const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

/** Saved choice, else the account's own country (anything other than India opens in Global). */
export function getRegion(tenant) {
  const saved = read(REGION_KEY);
  if (saved === 'IN' || saved === 'GLOBAL') return saved;
  const cc = String(tenant?.countryCode || '').toUpperCase();
  return cc && cc !== 'IN' ? 'GLOBAL' : 'IN';
}
export const setRegion = (r) => write(REGION_KEY, r === 'IN' ? 'IN' : 'GLOBAL');

export function getCurrency(region) {
  return read(CURRENCY_KEY) || (region === 'IN' ? 'INR' : 'USD');
}
export const setCurrency = (c) => write(CURRENCY_KEY, c);
