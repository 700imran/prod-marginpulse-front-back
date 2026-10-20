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
import { getOcrLines } from './ocr';
import { normalizeErrorBody } from './apiErrors';
import { setUserIdGetter, userIdFromToken } from './apiCache';

const BASE = process.env.REACT_APP_API_URL || '';

function getToken() {
  return tokenManager.getAccessToken();
}

function authHeaders() {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// Lets apiCache namespace cached data by user without importing tokenManager.
setUserIdGetter(() => { const t = getToken(); return t ? userIdFromToken(t) : null; });

// A sleeping backend / database can take several seconds to answer the first
// request. For READS (GET) that is safe to wait out and safe to retry, so:
// give each attempt a generous timeout and retry once or twice on a network
// failure, timeout or 502/503/504. Writes (POST/PUT/DELETE) are never
// retried automatically — repeating one could do the thing twice — and keep
// their original no-timeout behaviour (uploads can legitimately be slow).
// Exported (mutable) only so tests can shrink the waits; app code never changes it.
export const _retryConfig = { timeoutMs: 20000, delaysMs: [600, 1500] };
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, init, isRead) {
  const attempts = isRead ? _retryConfig.delaysMs.length + 1 : 1;
  let lastError;
  for (let i = 0; i < attempts; i++) {
    const controller = isRead ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), _retryConfig.timeoutMs) : null;
    try {
      const res = await fetch(url, controller ? { ...init, signal: controller.signal } : init);
      if (isRead && RETRYABLE_STATUS.has(res.status) && i < attempts - 1) {
        lastError = new Error(`HTTP ${res.status}`);
      } else {
        return res;
      }
    } catch (e) {
      lastError = e; // network failure or timeout (AbortError)
      if (i === attempts - 1) throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
    await sleep(_retryConfig.delaysMs[i]);
  }
  throw lastError;
}

async function request(method, path, body) {
  const res = await fetchWithRetry(`${BASE}${path}`, {
    method,
    headers: authHeaders(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, method === 'GET');
  if (res.status === 401) {
    // Try Supabase's own refresh (it also auto-refreshes in the
    // background, but this covers the case where a request landed
    // just before that had a chance to run).
    const { data, error } = await supabase.auth.refreshSession();
    if (error || !data?.session) {
      tokenManager.clearTokens();
      window.location.href = '/';
      return null;
    }
    // Retry original request with the refreshed token
    return request(method, path, body);
  }
  return normalizeErrorBody(await res.json());
}

// ── Auth ──────────────────────────────────────────────────────────────────────
// Sign-in/sign-up themselves live in LoginPage.jsx, calling Supabase
// directly (supabase.auth.signInWithPassword / signUp) — there's no
// /api/v1/auth/login or /register endpoint on this backend anymore for
// this module to wrap. This file keeps only the two things the rest of
// the app actually calls on api.* : logout and an auth-state check.

export function logout() {
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

// Numbers only — no AI paragraph, no credit spent, no waiting on the model.
// This is what lets the dashboard paint immediately.
export async function getDashboardFast(period = '2026-Q2') {
  return request('GET', `/api/v1/reconciliation/dashboard-summary?tax_period=${period}&insight=false`);
}

// Just the AI paragraph, fetched after the numbers are already on screen.
// The backend caches it per tenant per set of numbers.
export async function getDashboardInsightText() {
  return request('GET', '/api/v1/reconciliation/dashboard-insight');
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
    const ocrResult = await getOcrLines(file);
    if (ocrResult?.lines?.length) {
      form.append('ocr_lines', JSON.stringify(ocrResult.lines));
    }
  } catch (e) {
    console.warn('[uploadDocument] client-side OCR failed, uploading without extracted fields', e);
  }

  const res = await fetch(`${BASE}/api/v1/documents/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: form,
  });
  return normalizeErrorBody(await res.json());
}

// ── Bank CSV ──────────────────────────────────────────────────────────────────
export async function uploadBankCSV(file, bankName = '') {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE}/api/v1/reconciliation/bank-csv-upload?bank_name=${encodeURIComponent(bankName)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: form,
  });
  return normalizeErrorBody(await res.json());
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
    headers: authHeaders(),
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
  return request('POST', '/api/v1/roi', payload);
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

// Password changes go through Supabase Auth directly — the Worker has no
// password endpoint (auth is Supabase's job end to end). Supabase's
// updateUser() doesn't ask for the current password, so we verify it first
// ourselves: an unattended or hijacked session shouldn't be able to set a new
// one without knowing the old. Returns the same { detail } shape the Security
// screen already reads.
export async function changePassword(currentPassword, newPassword) {
  const { data } = await supabase.auth.getSession();
  const user = data?.session?.user;
  if (!user?.email) return { detail: 'Your session has expired. Please log in again.' };
  const providers = user.app_metadata?.providers || [];
  if (providers.length > 0 && !providers.includes('email')) {
    return { detail: "This account signs in with Google, so it doesn't have a password to change." };
  }
  const { error: wrongPassword } = await supabase.auth.signInWithPassword({ email: user.email, password: currentPassword });
  if (wrongPassword) return { detail: 'Current password is incorrect' };
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { detail: error.message || 'Could not change password' };
  return { detail: 'Password changed successfully' };
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
    headers: authHeaders(),
  });
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
    headers: authHeaders(),
  });
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

// ── Assistant ─────────────────────────────────────────────────────────────────
// Unlike request() above (which returns only the parsed body), the assistant
// UI needs the HTTP status — 402 / 409 / 429 / 501 each mean something
// different to the user — so these return { status, body }. Error bodies
// follow the backend envelope: { error: { code, message, details? } }.
async function requestWithStatus(method, path, body, retried = false) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: authHeaders(),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    return { status: 0, body: null }; // network failure
  }
  if (res.status === 401 && !retried) {
    const { data, error } = await supabase.auth.refreshSession();
    if (error || !data?.session) {
      tokenManager.clearTokens();
      window.location.href = '/';
      return { status: 401, body: null };
    }
    return requestWithStatus(method, path, body, true);
  }
  let parsed = null;
  try { parsed = await res.json(); } catch { /* empty / non-JSON body */ }
  return { status: res.status, body: parsed };
}

export function assistantMessage(message, conversationHistory) {
  return requestWithStatus('POST', '/api/v1/assistant/message', { message, conversation_history: conversationHistory });
}

export function assistantConfirm(confirmationToken) {
  return requestWithStatus('POST', '/api/v1/assistant/confirm', { confirmation_token: confirmationToken });
}
