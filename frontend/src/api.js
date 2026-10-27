/**
 * api.js — Centralised API client for MarginPulse Pro frontend.
 * All fetch calls go through here. Auth token comes from Supabase's
 * session (via tokenManager, which wraps supabase-js) — not raw
 * localStorage reads under this app's own keys, since Supabase
 * persists its session under its own key. See supabaseClient.js and
 * security/tokenManager.js.
 *
 * DEPLOYMENT NOTE: this frontend deploys as a standalone static site
 * on Vercel — REACT_APP_API_URL, REACT_APP_SUPABASE_URL, and
 * REACT_APP_SUPABASE_ANON_KEY MUST be set as build-time environment
 * variables there (Create React App bakes process.env.REACT_APP_*
 * into the bundle AT BUILD TIME, not at runtime — changing them
 * requires a rebuild, not just a redeploy of the same build).
 */
import { supabase } from './supabaseClient';
import { tokenManager } from './security/tokenManager';

const BASE = process.env.REACT_APP_API_URL || '';

async function authHeaders() {
  // Waits only if the stored token is missing/expiring (see tokenManager).
  const token = await tokenManager.getValidAccessToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// ── Stale-while-revalidate data cache ────────────────────────────────────────
// GET responses are kept in sessionStorage (per user, wiped on logout / tab close).
// A refresh therefore paints every screen from the last known data in milliseconds,
// then refreshes in the background; if anything changed, the app is told via the
// 'mp:data-updated' event and re-reads (from cache, instantly).
const CACHE_PREFIX = 'mp_cache:';
const FRESH_MS = 8000; // newer than this: no network at all
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const inflightGets = new Map();

const cacheKey = (path) => `${CACHE_PREFIX}${tokenManager.getTenantId()}:${path}`;
const isCacheable = (path) => !/\/api\/v1\/admin|download|export/.test(path);
const isErrorPayload = (v) => v && typeof v === 'object' && !Array.isArray(v) && 'error' in v;

function readCache(path) {
  try {
    const raw = sessionStorage.getItem(cacheKey(path));
    const e = raw ? JSON.parse(raw) : null;
    return e && Date.now() - e.t < MAX_AGE_MS ? e : null;
  } catch { return null; }
}
function writeCache(path, v) {
  try { sessionStorage.setItem(cacheKey(path), JSON.stringify({ t: Date.now(), v })); } catch { /* quota: just skip */ }
}
export function clearDataCache() {
  try {
    Object.keys(sessionStorage).filter((k) => k.startsWith(CACHE_PREFIX)).forEach((k) => sessionStorage.removeItem(k));
  } catch { /* ignore */ }
  inflightGets.clear();
}

function fetchAndCache(path) {
  if (inflightGets.has(path)) return inflightGets.get(path);
  const p = doRequest('GET', path)
    .then((v) => { if (isCacheable(path) && v && !isErrorPayload(v)) writeCache(path, v); return v; })
    .finally(() => inflightGets.delete(path));
  inflightGets.set(path, p);
  return p;
}

async function request(method, path, body) {
  if (method === 'GET') {
    const hit = isCacheable(path) ? readCache(path) : null;
    if (hit) {
      if (Date.now() - hit.t > FRESH_MS) {
        fetchAndCache(path).then((fresh) => {
          if (fresh && !isErrorPayload(fresh) && JSON.stringify(fresh) !== JSON.stringify(hit.v)) {
            window.dispatchEvent(new Event('mp:data-updated'));
          }
        }).catch(() => {});
      }
      return hit.v;
    }
    return fetchAndCache(path);
  }
  clearDataCache(); // any write invalidates cached reads (before and after, so nothing stale survives)
  try { return await doRequest(method, path, body); } finally { clearDataCache(); }
}

async function doRequest(method, path, body, retried = false) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: await authHeaders(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401 && !retried) {
    // Try Supabase's own refresh once (covers a token that expired in flight).
    const { data, error } = await supabase.auth.refreshSession();
    if (error || !data?.session) {
      clearClientState();
      tokenManager.clearTokens();
      window.location.href = '/';
      return null;
    }
    return doRequest(method, path, body, true);
  }
  return res.json();
}

function clearClientState() {
  clearDataCache();
  try { sessionStorage.removeItem('mp_profile'); localStorage.removeItem('mp_identity'); } catch { /* ignore */ }
}

/**
 * Warm the cache for every main screen in the background (called once after the
 * shell paints), so the first click on any feature is already instant.
 */
export function prefetchAppData() {
  const jobs = [
    () => getDashboard(), () => listAnomalies('OPEN'), () => listBankAccounts(), () => listTaxIdentifiers(),
    () => getDashboardInsights(), () => listDocuments(), () => getReconciliationSettings(),
    () => getNotificationSettings(), () => getIntegrationSettings(), () => listIntegrations(),
    () => listTeamMembers(), () => getAuditLog(undefined, undefined, 200), () => getVendorGSTStatus(), () => getITCSummary(),
  ];
  (async () => {
    for (let i = 0; i < jobs.length; i += 4) {
      await Promise.allSettled(jobs.slice(i, i + 4).map((j) => j()));
    }
  })();
}

// ── Auth ──────────────────────────────────────────────────────────────────────
// Sign-in/sign-up themselves live in LoginPage.jsx, calling Supabase
// directly (supabase.auth.signInWithPassword / signUp) — there's no
// /api/v1/auth/login or /register endpoint on this backend anymore for
// this module to wrap. This file keeps only the two things the rest of
// the app actually calls on api.* : logout and an auth-state check.

export function logout() {
  clearClientState();
  tokenManager.clearTokens();
  window.location.href = '/';
}

export function isLoggedIn() {
  return tokenManager.isAuthenticated();
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export async function getDashboard(period = '2026-Q2') {
  return request('GET', `/api/v1/reconciliation/dashboard-summary?tax_period=${period}`);
}

// ── Documents ─────────────────────────────────────────────────────────────────
export async function listDocuments(status, docType) {
  const params = new URLSearchParams();
  if (status) params.append('status', status);
  if (docType) params.append('doc_type', docType);
  return request('GET', `/api/v1/documents?${params}`);
}

// OCR runs client-side before the file ever reaches the network — see
// ocr/index.js for why (no AWS account for a server-side OCR Lambda).
// This is always best-effort: any OCR failure just means the document
// uploads without extracted fields (ocrAvailable: false server-side),
// never blocks the upload itself.
export async function uploadDocument(file, docType = 'INVOICE') {
  const form = new FormData();
  form.append('file', file);
  form.append('doc_type', docType);

  try {
    const { getOcrLines } = await import('./ocr'); // lazy: keeps pdfjs/tesseract out of the main bundle
    const ocrResult = await getOcrLines(file);
    if (ocrResult?.lines?.length) {
      form.append('ocr_lines', JSON.stringify(ocrResult.lines));
    }
  } catch (e) {
    console.warn('[uploadDocument] client-side OCR failed, uploading without extracted fields', e);
  }

  const res = await fetch(`${BASE}/api/v1/documents/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await tokenManager.getValidAccessToken()}` },
    body: form,
  });
  clearDataCache();
  return res.json();
}

// ── Any tabular dataset (CSV/TSV/XLSX/JSON/XML/TXT) ──────────────────────────
// Parsed in the browser (lazy), classified + normalised + reconciled server-side.
export async function uploadDataset(file, bankName = '') {
  const { parseFileToGrid } = await import('./ingest/parseFile');
  let rows;
  try {
    rows = await parseFileToGrid(file);
  } catch (e) {
    return { error: e.message || 'Could not read this file' };
  }
  const res = await fetch(`${BASE}/api/v1/reconciliation/dataset-upload`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ fileName: file.name, bankName, rows }),
  });
  clearDataCache();
  return res.json();
}

// ── Bank CSV ──────────────────────────────────────────────────────────────────
export async function uploadBankCSV(file, bankName = '') {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE}/api/v1/reconciliation/bank-csv-upload?bank_name=${encodeURIComponent(bankName)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await tokenManager.getValidAccessToken()}` },
    body: form,
  });
  clearDataCache();
  return res.json();
}

// ── Reconciliation ────────────────────────────────────────────────────────────
export async function triggerReconciliation() {
  return request('POST', '/api/v1/reconciliation/run');
}

export async function listAnomalies(status = 'OPEN') {
  return request('GET', `/api/v1/reconciliation/anomalies?status=${status}`);
}

export async function resolveAnomaly(anomalyId) {
  return request('POST', `/api/v1/reconciliation/anomaly/${anomalyId}/resolve`);
}

// ── Dashboard insights (ITC risk, vendor follow-up, filing deadlines) ─────────
export async function getDashboardInsights() {
  return request('GET', '/api/v1/reconciliation/dashboard-insights');
}

// ── Missing invoice detection ─────────────────────────────────────────────────
export async function detectMissingInvoices() {
  return request('POST', '/api/v1/reconciliation/detect-missing-invoices');
}

// ── Reconciliation report export (CSV) ────────────────────────────────────────
// Not JSON, so this bypasses the shared request() helper and triggers a
// browser download directly rather than returning parsed data.
export async function downloadReconciliationReport() {
  const res = await fetch(`${BASE}/api/v1/reconciliation/export`, {
    method: 'GET',
    headers: await authHeaders(),
  });
  if (!res.ok) return false;
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  link.download = match ? match[1] : `reconciliation-report-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
  return true;
}

// ── Manual correction workflow ────────────────────────────────────────────────
export async function correctDocument(documentId, fields, reason) {
  return request('PATCH', `/api/v1/documents/${documentId}/correct`, { ...fields, reason });
}

// ── Audit trail ────────────────────────────────────────────────────────────────
export async function getDocumentAuditLog(documentId) {
  return request('GET', `/api/v1/documents/${documentId}/audit-log`);
}

export async function getAuditLog(entityType, entityId, limit = 100) {
  const params = new URLSearchParams();
  if (entityType) params.append('entity_type', entityType);
  if (entityId) params.append('entity_id', entityId);
  params.append('limit', limit);
  return request('GET', `/api/v1/audit-log?${params}`);
}

// ── ROI calculator (public — no auth required, works for marketing site too) ─
export async function calculateROI(payload) {
  return request('POST', '/api/v1/roi-calculator', payload);
}

// ── GST ───────────────────────────────────────────────────────────────────────
export async function getVendorGSTStatus() {
  return request('GET', '/api/v1/gst/vendor-status');
}

export async function triggerGSTSync(period) {
  return request('POST', `/api/v1/gst/sync?period=${period}`);
}

export async function getITCSummary() {
  return request('GET', '/api/v1/gst/itc-summary');
}

// ── Comms ─────────────────────────────────────────────────────────────────────
export async function generateReminder(documentId, issueType = 'GST_PORTAL_MISMATCH') {
  return request('GET', `/api/v1/comms/generate-reminder?document_id=${documentId}&issue_type=${issueType}`);
}

// ── Health ────────────────────────────────────────────────────────────────────
export async function healthCheck() {
  const res = await fetch(`${BASE}/health`);
  return res.json();
}

// ── Profile (Stage 1) ─────────────────────────────────────────────────────────
export async function getProfile() {
  return request('GET', '/api/v1/auth/me');
}

export async function updateProfile(fields) {
  // fields: { business_name?, display_name?, phone_number? } — only send
  // keys that are actually being changed; the backend treats this as a
  // true partial update (PATCH semantics), not a full overwrite.
  return request('PATCH', '/api/v1/auth/me', fields);
}

export async function changePassword(currentPassword, newPassword) {
  return request('POST', '/api/v1/auth/change-password', {
    current_password: currentPassword,
    new_password: newPassword,
  });
}

// ── Tax Identifiers (GSTIN / PAN) ──────────────────────────────────────────────
export async function listTaxIdentifiers() {
  return request('GET', '/api/v1/tax-identifiers');
}

export async function addTaxIdentifier(idType, idValue, label) {
  return request('POST', '/api/v1/tax-identifiers', { id_type: idType, id_value: idValue, label });
}

export async function reverifyTaxIdentifier(taxIdentifierId) {
  return request('POST', `/api/v1/tax-identifiers/${taxIdentifierId}/reverify`);
}

export async function deleteTaxIdentifier(taxIdentifierId) {
  const res = await fetch(`${BASE}/api/v1/tax-identifiers/${taxIdentifierId}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  clearDataCache();
  return res.status === 204;
}

export async function setPrimaryTaxIdentifier(taxIdentifierId) {
  return request('POST', `/api/v1/tax-identifiers/${taxIdentifierId}/set-primary`);
}

// ── Bank Accounts ───────────────────────────────────────────────────────────────
export async function listBankAccounts() {
  return request('GET', '/api/v1/bank-accounts');
}

export async function linkBankAccount(fields) {
  // fields: { bank_name, account_holder_name, account_number, ifsc_code, account_type }
  return request('POST', '/api/v1/bank-accounts', fields);
}

export async function reverifyBankAccount(bankAccountId) {
  return request('POST', `/api/v1/bank-accounts/${bankAccountId}/reverify`);
}

export async function unlinkBankAccount(bankAccountId) {
  const res = await fetch(`${BASE}/api/v1/bank-accounts/${bankAccountId}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  clearDataCache();
  return res.status === 204;
}

export async function setPrimaryBankAccount(bankAccountId) {
  return request('POST', `/api/v1/bank-accounts/${bankAccountId}/set-primary`);
}

// ── Settings: Reconciliation Rules ──────────────────────────────────────────────
export async function getReconciliationSettings() {
  return request('GET', '/api/v1/settings/reconciliation');
}

export async function updateReconciliationSettings(fields) {
  return request('PATCH', '/api/v1/settings/reconciliation', fields);
}

// ── Settings: Notifications ──────────────────────────────────────────────────────
export async function getNotificationSettings() {
  return request('GET', '/api/v1/settings/notifications');
}

export async function updateNotificationSettings(fields) {
  return request('PATCH', '/api/v1/settings/notifications', fields);
}

// ── Settings: Integrations ───────────────────────────────────────────────────────
export async function getIntegrationSettings() {
  return request('GET', '/api/v1/settings/integrations');
}

export async function updateIntegrationSettings(fields) {
  return request('PATCH', '/api/v1/settings/integrations', fields);
}

// ── Audit Team ───────────────────────────────────────────────────────────────────
export async function listTeamMembers() {
  return request('GET', '/api/v1/team');
}

export async function inviteTeamMember(email, role = 'VIEWER') {
  return request('POST', '/api/v1/team/invite', { email, role });
}

export async function revokeTeamMember(teamMemberId) {
  return request('POST', `/api/v1/team/${teamMemberId}/revoke`);
}

// ── Payment & Business Tool Integrations ───────────────────────────────────────
export async function listIntegrations() {
  return request('GET', '/api/v1/integrations');
}

export async function connectIntegration(provider, credentials) {
  return request('POST', `/api/v1/integrations/${provider}/connect`, { credentials });
}

export async function syncIntegration(provider) {
  return request('POST', `/api/v1/integrations/${provider}/sync`);
}

export async function disconnectIntegration(provider) {
  return request('POST', `/api/v1/integrations/${provider}/disconnect`);
}

export function getSlackConnectUrl() {
  return `${BASE}/api/v1/integrations/slack/connect`;
}

// ── Platform Admin Panel (requires tenant.is_platform_admin) ──────────────────
export async function getPlatformSettings() {
  return request('GET', '/api/v1/admin/settings');
}

export async function updatePlatformSettings(fields) {
  return request('PATCH', '/api/v1/admin/settings', fields);
}

export async function listAllTenants() {
  return request('GET', '/api/v1/admin/tenants');
}

export async function setTenantActive(tenantId, isActive) {
  return request('PATCH', `/api/v1/admin/tenants/${tenantId}/active`, { is_active: isActive });
}

export async function getSystemStats() {
  return request('GET', '/api/v1/admin/stats');
}
