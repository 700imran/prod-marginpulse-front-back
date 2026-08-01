package httpapi

import "net/http"

// NewRouter builds the complete route table using Go 1.22's
// pattern-based net/http.ServeMux ("METHOD /path/{param}" syntax) — no
// external router dependency needed. Ported from app/api/v1/router.py.
func NewRouter() http.Handler {
	mux := http.NewServeMux()

	// ── Health (no auth, no rate limit) ─────────────────────────────────
	mux.HandleFunc("GET /health", HandleHealth)
	mux.HandleFunc("GET /health/ready", HandleReady)

	// ── Public marketing/dashboard tools (no auth) ────────────────────────
	mux.HandleFunc("POST /api/v1/roi-calculator", HandleROICalculator)

	// ── Auth ─────────────────────────────────────────────────────────────
	mux.HandleFunc("POST /api/v1/auth/register", HandleRegister)
	mux.HandleFunc("POST /api/v1/auth/login", HandleLogin)
	mux.HandleFunc("POST /api/v1/auth/refresh", HandleRefresh)
	mux.HandleFunc("POST /api/v1/auth/logout", RequireAuth(HandleLogout))
	mux.HandleFunc("GET /api/v1/auth/me", RequireAuth(HandleGetProfile))
	mux.HandleFunc("PATCH /api/v1/auth/me", RequireAuth(HandleUpdateProfile))
	mux.HandleFunc("POST /api/v1/auth/change-password", RequireAuth(HandleChangePassword))
	mux.HandleFunc("GET /api/v1/auth/google/login", HandleGoogleLogin)
	mux.HandleFunc("GET /api/v1/auth/google/callback", HandleGoogleCallback)
	mux.HandleFunc("GET /api/v1/auth/apple/login", HandleAppleLogin)
	mux.HandleFunc("POST /api/v1/auth/apple/callback", HandleAppleCallback)

	// ── OAuth login (Google, Apple) ──────────────────────────────────────
	mux.HandleFunc("GET /api/v1/auth/google/login", HandleGoogleLogin)
	mux.HandleFunc("GET /api/v1/auth/google/callback", HandleGoogleCallback)
	mux.HandleFunc("GET /api/v1/auth/apple/login", HandleAppleLogin)
	mux.HandleFunc("POST /api/v1/auth/apple/callback", HandleAppleCallback)

	// ── Integrations (payment gateways, business tools) ──────────────────
	mux.HandleFunc("GET /api/v1/integrations", RequireAuth(HandleListIntegrations))
	mux.HandleFunc("POST /api/v1/integrations/{provider}/connect", RequireAuth(func(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
		HandleConnectAPIKeyIntegration(w, r, tc, r.PathValue("provider"))
	}))
	mux.HandleFunc("POST /api/v1/integrations/{provider}/sync", RequireAuth(func(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
		HandleSyncIntegration(w, r, tc, r.PathValue("provider"))
	}))
	mux.HandleFunc("POST /api/v1/integrations/{provider}/disconnect", RequireAuth(func(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
		HandleDisconnectIntegration(w, r, tc, r.PathValue("provider"))
	}))
	mux.HandleFunc("GET /api/v1/integrations/slack/connect", RequireAuth(HandleSlackConnect))
	mux.HandleFunc("GET /api/v1/integrations/slack/callback", HandleSlackCallback)

	// ── Platform admin panel (RequirePlatformAdmin — see middleware.go) ──
	mux.HandleFunc("GET /api/v1/admin/settings", RequirePlatformAdmin(HandleGetPlatformSettings))
	mux.HandleFunc("PATCH /api/v1/admin/settings", RequirePlatformAdmin(HandleUpdatePlatformSettings))
	mux.HandleFunc("GET /api/v1/admin/tenants", RequirePlatformAdmin(HandleListAllTenants))
	mux.HandleFunc("PATCH /api/v1/admin/tenants/{id}/active", RequirePlatformAdmin(func(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
		HandleSetTenantActive(w, r, tc, r.PathValue("id"))
	}))
	mux.HandleFunc("GET /api/v1/admin/stats", RequirePlatformAdmin(HandleGetSystemStats))

	// ── Documents ────────────────────────────────────────────────────────
	mux.HandleFunc("POST /api/v1/documents/upload", RequireAuth(HandleUploadDocument))
	mux.HandleFunc("GET /api/v1/documents", RequireAuth(HandleListDocuments))
	mux.HandleFunc("GET /api/v1/documents/{id}", RequireAuth(func(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
		HandleGetDocument(w, r, tc, r.PathValue("id"))
	}))
	mux.HandleFunc("GET /api/v1/documents/{id}/download-url", RequireAuth(func(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
		HandleGetDocumentDownloadURL(w, r, tc, r.PathValue("id"))
	}))
	mux.HandleFunc("GET /api/v1/documents/file/{key...}", RequireAuth(func(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
		HandleServeLocalFile(w, r, tc, r.PathValue("key"))
	}))
	mux.HandleFunc("PATCH /api/v1/documents/{id}/correct", RequireAuth(func(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
		HandleCorrectDocument(w, r, tc, r.PathValue("id"))
	}))
	mux.HandleFunc("GET /api/v1/documents/{id}/audit-log", RequireAuth(func(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
		HandleGetDocumentAuditLog(w, r, tc, r.PathValue("id"))
	}))

	// ── Audit trail (tenant-wide) ────────────────────────────────────────
	mux.HandleFunc("GET /api/v1/audit-log", RequireAuth(HandleListAuditLog))

	// ── Reconciliation ───────────────────────────────────────────────────
	mux.HandleFunc("GET /api/v1/reconciliation/dashboard-summary", RequireAuth(HandleDashboardSummary))
	mux.HandleFunc("GET /api/v1/dashboard/insights", RequireAuth(HandleDashboardInsights))
	mux.HandleFunc("POST /api/v1/reconciliation/run", RequireAuth(HandleRunReconciliation))
	mux.HandleFunc("POST /api/v1/reconciliation/bank-csv-upload", RequireAuth(HandleBankCSVUpload))
	mux.HandleFunc("GET /api/v1/reconciliation/anomalies", RequireAuth(HandleListAnomalies))
	mux.HandleFunc("POST /api/v1/reconciliation/anomaly/{id}/resolve", RequireAuth(func(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
		HandleResolveAnomaly(w, r, tc, r.PathValue("id"))
	}))
	mux.HandleFunc("GET /api/v1/reconciliation/export", RequireAuth(HandleExportReconciliationReport))
	mux.HandleFunc("POST /api/v1/reconciliation/detect-missing-invoices", RequireAuth(HandleDetectMissingInvoices))

	// ── Webhooks (no auth — verified via shared secret/signature instead) ─
	mux.HandleFunc("GET /api/v1/webhook/whatsapp", HandleWhatsAppVerify)
	mux.HandleFunc("POST /api/v1/webhook/whatsapp", HandleWhatsAppIngest)
	mux.HandleFunc("POST /api/v1/webhook/email-ingest", HandleEmailIngest)

	// ── GST ──────────────────────────────────────────────────────────────
	mux.HandleFunc("POST /api/v1/gst/sync", RequireAuth(HandleTriggerGSTSync))
	mux.HandleFunc("GET /api/v1/gst/vendor-status", RequireAuth(HandleVendorStatus))
	mux.HandleFunc("GET /api/v1/gst/itc-summary", RequireAuth(HandleITCSummary))

	// ── Comms ────────────────────────────────────────────────────────────
	mux.HandleFunc("GET /api/v1/comms/generate-reminder", RequireAuth(HandleGenerateReminder))

	// ── Tax identifiers ──────────────────────────────────────────────────
	mux.HandleFunc("GET /api/v1/tax-identifiers", RequireAuth(HandleListTaxIdentifiers))
	mux.HandleFunc("POST /api/v1/tax-identifiers", RequireAuth(HandleCreateTaxIdentifier))
	mux.HandleFunc("POST /api/v1/tax-identifiers/{id}/reverify", RequireAuth(func(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
		HandleReverifyTaxIdentifier(w, r, tc, r.PathValue("id"))
	}))
	mux.HandleFunc("POST /api/v1/tax-identifiers/{id}/set-primary", RequireAuth(func(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
		HandleSetPrimaryTaxIdentifier(w, r, tc, r.PathValue("id"))
	}))
	mux.HandleFunc("DELETE /api/v1/tax-identifiers/{id}", RequireAuth(func(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
		HandleDeleteTaxIdentifier(w, r, tc, r.PathValue("id"))
	}))

	// ── Bank accounts ────────────────────────────────────────────────────
	mux.HandleFunc("GET /api/v1/bank-accounts", RequireAuth(HandleListBankAccounts))
	mux.HandleFunc("POST /api/v1/bank-accounts", RequireAuth(HandleCreateBankAccount))
	mux.HandleFunc("POST /api/v1/bank-accounts/{id}/set-primary", RequireAuth(func(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
		HandleSetPrimaryBankAccount(w, r, tc, r.PathValue("id"))
	}))
	mux.HandleFunc("DELETE /api/v1/bank-accounts/{id}", RequireAuth(func(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
		HandleDeleteBankAccount(w, r, tc, r.PathValue("id"))
	}))

	// ── Settings ─────────────────────────────────────────────────────────
	mux.HandleFunc("GET /api/v1/settings/reconciliation", RequireAuth(HandleGetReconciliationSettings))
	mux.HandleFunc("PATCH /api/v1/settings/reconciliation", RequireAuth(HandleUpdateReconciliationSettings))
	mux.HandleFunc("GET /api/v1/settings/notifications", RequireAuth(HandleGetNotificationSettings))
	mux.HandleFunc("PATCH /api/v1/settings/notifications", RequireAuth(HandleUpdateNotificationSettings))
	mux.HandleFunc("GET /api/v1/settings/integrations", RequireAuth(HandleGetIntegrationSettings))
	mux.HandleFunc("PATCH /api/v1/settings/integrations", RequireAuth(HandleUpdateIntegrationSettings))

	// ── Team ─────────────────────────────────────────────────────────────
	mux.HandleFunc("GET /api/v1/team", RequireAuth(HandleListTeamMembers))
	mux.HandleFunc("POST /api/v1/team/invite", RequireAuth(HandleInviteTeamMember))
	mux.HandleFunc("POST /api/v1/team/{id}/revoke", RequireAuth(func(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
		HandleRevokeTeamMember(w, r, tc, r.PathValue("id"))
	}))

	// Middleware chain — applied outermost-first, matching main.py's
	// FastAPI middleware stack order (CORS -> security headers -> request
	// ID/logging), so the same layer runs on every route including 404s.
	var handler http.Handler = mux
	handler = RequestIDMiddleware(handler)
	handler = SecurityHeadersMiddleware(handler)
	handler = CORSMiddleware(handler)
	return handler
}
