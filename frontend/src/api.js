/**
 * api.js — Centralised API client for MarginPulse Pro frontend.
 * All fetch calls go through here. Token is stored in localStorage.
 *
 * DEPLOYMENT NOTE (multi-repo split): this frontend deploys as a
 * standalone static site (e.g. Cloudflare Pages) with no reverse proxy
 * in front of it — there is no nginx container co-located with this
 * build anymore. REACT_APP_API_URL MUST be set to the real, public URL
 * of the deployed backend-api service (e.g.
 * https://marginpulse-api.onrender.com) in your hosting platform's
 * build-time environment variables. Create React App bakes
 * process.env.REACT_APP_* values into the JS bundle AT BUILD TIME, not
 * at runtime — so this must be set before the build step runs, and
 * changing it requires a rebuild, not just a container restart.
 */
const BASE = process.env.REACT_APP_API_URL || '';

function getToken() {
  return localStorage.getItem('mp_access_token') || '';
}

function authHeaders() {
  const token = getToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: authHeaders(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) {
    // Try refresh
    const refreshed = await refreshToken();
    if (!refreshed) {
      localStorage.removeItem('mp_access_token');
      localStorage.removeItem('mp_refresh_token');
      window.location.href = '/';
      return null;
    }
    // Retry original request with new token
    return request(method, path, body);
  }
  return res.json();
}

async function refreshToken() {
  const rt = localStorage.getItem('mp_refresh_token');
  if (!rt) return false;
  try {
    const res = await fetch(`${BASE}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: rt }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    localStorage.setItem('mp_access_token', data.access_token);
    localStorage.setItem('mp_refresh_token', data.refresh_token);
    return true;
  } catch { return false; }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
export async function register(businessName, email, password, countryCode = 'IND') {
  const data = await request('POST', '/api/v1/auth/register', {
    business_name: businessName, email, password, country_code: countryCode,
  });
  if (data?.access_token) {
    localStorage.setItem('mp_access_token', data.access_token);
    localStorage.setItem('mp_refresh_token', data.refresh_token);
    localStorage.setItem('mp_tenant_id', data.tenant_id);
  }
  return data;
}

export async function login(email, password) {
  const data = await request('POST', '/api/v1/auth/login', { email, password });
  if (data?.access_token) {
    localStorage.setItem('mp_access_token', data.access_token);
    localStorage.setItem('mp_refresh_token', data.refresh_token);
    localStorage.setItem('mp_tenant_id', data.tenant_id);
  }
  return data;
}

export async function logout() {
  // FIX: this previously only cleared localStorage — the token itself
  // stayed valid server-side until natural expiry. Now calls the real
  // /auth/logout endpoint first, which revokes both tokens via Redis,
  // then clears local state regardless of whether the network call
  // succeeds (so a flaky connection never traps the user in a logged-in
  // UI state with no way out).
  const rt = localStorage.getItem('mp_refresh_token');
  try {
    await fetch(`${BASE}/api/v1/auth/logout`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ refresh_token: rt || null }),
    });
  } catch {
    // Network failure during logout shouldn't block the user from
    // leaving the app locally — server-side tokens will still expire
    // naturally even if this particular revoke call didn't land.
  }
  localStorage.clear();
  window.location.href = '/';
}

export function isLoggedIn() {
  return !!localStorage.getItem('mp_access_token');
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

export async function uploadDocument(file, docType = 'INVOICE') {
  const form = new FormData();
  form.append('file', file);
  form.append('doc_type', docType);
  const res = await fetch(`${BASE}/api/v1/documents/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
    body: form,
  });
  return res.json();
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
  return request('GET', '/api/v1/dashboard/insights');
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
