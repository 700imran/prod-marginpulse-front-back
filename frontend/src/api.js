import { supabase } from './supabaseClient';
import { tokenManager } from './security/tokenManager';
import { getOcrLines } from './ocr';

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

function normalizeProfile(data) {
  if (!data || typeof data !== 'object') return data;
  return {
    ...data,
    tenantId: data.tenant_id ?? data.tenantId ?? '',
    displayName: data.display_name ?? data.displayName ?? data.business_name ?? data.businessName ?? '',
    businessName: data.business_name ?? data.businessName ?? '',
    ownerEmail: data.owner_email ?? data.ownerEmail ?? '',
    phoneNumber: data.phone_number ?? data.phoneNumber ?? '',
    countryCode: data.country_code ?? data.countryCode ?? '',
    gstinNumber: data.gstin_number ?? data.gstinNumber ?? '',
    gstRegistered: Boolean(data.gst_registered ?? data.gstRegistered ?? false),
    whatsappBindingPhone: data.whatsapp_binding_phone ?? data.whatsappBindingPhone ?? '',
    ingestEmailAlias: data.ingest_email_alias ?? data.ingestEmailAlias ?? '',
    planTier: data.plan_tier ?? data.planTier ?? '',
    isPlatformAdmin: Boolean(data.is_platform_admin ?? data.isPlatformAdmin ?? false),
    createdAt: data.created_at ?? data.createdAt ?? '',
  };
}

async function request(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: authHeaders(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) {
    const { data, error } = await supabase.auth.refreshSession();
    if (error || !data?.session) {
      tokenManager.clearTokens();
      window.location.href = '/';
      return null;
    }
    return request(method, path, body);
  }
  return res.json();
}

// ── Auth ────────────────────────────────────────────────────────────
export function logout() {
  tokenManager.clearTokens();
  window.location.href = '/';
}

export function isLoggedIn() {
  return tokenManager.isAuthenticated();
}

// ── Dashboard ──────────────────────────────────────────────────────────
export async function getDashboard(period = '2026-Q2') {
  return request('GET', `/api/v1/reconciliation/dashboard-summary?tax_period=${period}`);
}

// ── Documents ──────────────────────────────────────────────────────────
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
  return res.json();
}

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

// ── Reconciliation ────────────────────────────────────────────────────────
export async function triggerReconciliation() {
  return request('POST', '/api/v1/reconciliation/run');
}

export async function listAnomalies(status = 'OPEN') {
  return request('GET', `/api/v1/reconciliation/anomalies?status=${status}`);
}

export async function resolveAnomaly(anomalyId) {
  return request('POST', `/api/v1/reconciliation/anomaly/${anomalyId}/resolve`);
}

export async function getDashboardInsights() {
  return request('GET', '/api/v1/dashboard/insights');
}

export async function detectMissingInvoices() {
  return request('POST', '/api/v1/reconciliation/detect-missing-invoices');
}

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

export async function correctDocument(documentId, fields, reason) {
  return request('PATCH', `/api/v1/documents/${documentId}/correct`, { ...fields, reason });
}

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

export async function calculateROI(payload) {
  return request('POST', '/api/v1/roi-calculator', payload);
}

export async function getVendorGSTStatus() {
  return request('GET', '/api/v1/gst/vendor-status');
}

export async function triggerGSTSync(period) {
  return request('POST', `/api/v1/gst/sync?period=${period}`);
}

export async function getITCSummary() {
  return request('GET', '/api/v1/gst/itc-summary');
}

export async function generateReminder(documentId, issueType = 'GST_PORTAL_MISMATCH') {
  return request('GET', `/api/v1/comms/generate-reminder?document_id=${documentId}&issue_type=${issueType}`);
}

export async function healthCheck() {
  const res = await fetch(`${BASE}/health`);
  return res.json();
}

// ── Profile (Stage 1) ───────────────────────────────────────────────────────
export async function getProfile() {
  const data = await request('GET', '/api/v1/auth/me');
  return data ? normalizeProfile(data) : null;
}

export async function updateProfile(fields) {
  const payload = {
    ...(fields.displayName !== undefined ? { display_name: fields.displayName || null } : {}),
    ...(fields.businessName !== undefined ? { business_name: fields.businessName || null } : {}),
    ...(fields.phoneNumber !== undefined ? { phone_number: fields.phoneNumber || null } : {}),
    ...(fields.whatsappBindingPhone !== undefined ? { whatsapp_binding_phone: fields.whatsappBindingPhone || null } : {}),
    ...(fields.ingestEmailAlias !== undefined ? { ingest_email_alias: fields.ingestEmailAlias || null } : {}),
  };
  const res = await request('PATCH', '/api/v1/auth/me', payload);
  return res ? normalizeProfile(res) : null;
}

export async function changePassword(currentPassword, newPassword) {
  return request('POST', '/api/v1/auth/change-password', {
    current_password: currentPassword,
    new_password: newPassword,
  });
}

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

export async function listBankAccounts() {
  return request('GET', '/api/v1/bank-accounts');
}

export async function linkBankAccount(fields) {
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

export async function getReconciliationSettings() {
  return request('GET', '/api/v1/settings/reconciliation');
}

export async function updateReconciliationSettings(fields) {
  return request('PATCH', '/api/v1/settings/reconciliation', fields);
}

export async function getNotificationSettings() {
  return request('GET', '/api/v1/settings/notifications');
}

export async function updateNotificationSettings(fields) {
  return request('PATCH', '/api/v1/settings/notifications', fields);
}

export async function getIntegrationSettings() {
  return request('GET', '/api/v1/settings/integrations');
}

export async function updateIntegrationSettings(fields) {
  return request('PATCH', '/api/v1/settings/integrations', fields);
}

export async function listTeamMembers() {
  return request('GET', '/api/v1/team');
}

export async function inviteTeamMember(email, role = 'VIEWER') {
  return request('POST', '/api/v1/team/invite', { email, role });
}

export async function revokeTeamMember(teamMemberId) {
  return request('POST', `/api/v1/team/${teamMemberId}/revoke`);
}

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
