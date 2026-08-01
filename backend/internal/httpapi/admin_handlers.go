package httpapi

import (
	"log/slog"
	"net/http"

	"github.com/marginpulse/backend/internal/repository"
	"github.com/marginpulse/backend/internal/security"
)

// ── Platform settings (OAuth/integration provider config + feature flags) ───

// maskSecret shows only that a secret is set, never its value, once it's
// already been saved — the admin panel's edit form should treat an
// unchanged masked field as "leave as-is" rather than round-tripping the
// real secret back to the browser on every page load.
func maskSecret(encrypted string) string {
	if encrypted == "" {
		return ""
	}
	return "••••••••" // presence, not value — real value only used server-side
}

type platformSettingsOut struct {
	GoogleClientID     string `json:"google_client_id"`
	GoogleClientSecret string `json:"google_client_secret"` // masked
	GoogleRedirectURI  string `json:"google_redirect_uri"`

	AppleClientID    string `json:"apple_client_id"`
	AppleTeamID      string `json:"apple_team_id"`
	AppleKeyID       string `json:"apple_key_id"`
	ApplePrivateKey  string `json:"apple_private_key"` // masked
	AppleRedirectURI string `json:"apple_redirect_uri"`

	SlackClientID     string `json:"slack_client_id"`
	SlackClientSecret string `json:"slack_client_secret"` // masked
	SlackRedirectURI  string `json:"slack_redirect_uri"`

	AIInsightsEnabled     *bool `json:"ai_insights_enabled"`
	WhatsAppIngestEnabled *bool `json:"whatsapp_ingest_enabled"`
	EmailIngestEnabled    *bool `json:"email_ingest_enabled"`
	RazorpayEnabled       *bool `json:"razorpay_integration_enabled"`
	StripeEnabled         *bool `json:"stripe_integration_enabled"`
	SlackIntegrationOn    *bool `json:"slack_integration_enabled"`
	NewSignupsEnabled     *bool `json:"new_signups_enabled"`

	UpdatedAt string `json:"updated_at,omitempty"`
	UpdatedBy string `json:"updated_by,omitempty"`
}

func platformSettingsOutFromItem(it *repository.PlatformSettingsItem) platformSettingsOut {
	return platformSettingsOut{
		GoogleClientID: it.GoogleClientID, GoogleClientSecret: maskSecret(it.GoogleClientSecretEnc),
		GoogleRedirectURI: it.GoogleRedirectURI,
		AppleClientID:     it.AppleClientID, AppleTeamID: it.AppleTeamID, AppleKeyID: it.AppleKeyID,
		ApplePrivateKey: maskSecret(it.ApplePrivateKeyEnc), AppleRedirectURI: it.AppleRedirectURI,
		SlackClientID: it.SlackClientID, SlackClientSecret: maskSecret(it.SlackClientSecretEnc),
		SlackRedirectURI:  it.SlackRedirectURI,
		AIInsightsEnabled: it.AIInsightsEnabled, WhatsAppIngestEnabled: it.WhatsAppIngestEnabled,
		EmailIngestEnabled: it.EmailIngestEnabled, RazorpayEnabled: it.RazorpayIntegrationOn,
		StripeEnabled: it.StripeIntegrationOn, SlackIntegrationOn: it.SlackIntegrationOn,
		NewSignupsEnabled: it.NewSignupsEnabled,
		UpdatedAt:         it.UpdatedAt, UpdatedBy: it.UpdatedBy,
	}
}

// HandleGetPlatformSettings mirrors GET /admin/settings.
func HandleGetPlatformSettings(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	repo := repository.NewPlatformSettingsRepo()
	item, err := repo.Get(r.Context())
	if err != nil {
		slog.Error("get platform settings failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not load platform settings")
		return
	}
	WriteJSON(w, http.StatusOK, platformSettingsOutFromItem(item))
}

type updatePlatformSettingsRequest struct {
	GoogleClientID     *string `json:"google_client_id"`
	GoogleClientSecret *string `json:"google_client_secret"` // if provided and non-masked, re-encrypted and stored
	GoogleRedirectURI  *string `json:"google_redirect_uri"`

	AppleClientID    *string `json:"apple_client_id"`
	AppleTeamID      *string `json:"apple_team_id"`
	AppleKeyID       *string `json:"apple_key_id"`
	ApplePrivateKey  *string `json:"apple_private_key"`
	AppleRedirectURI *string `json:"apple_redirect_uri"`

	SlackClientID     *string `json:"slack_client_id"`
	SlackClientSecret *string `json:"slack_client_secret"`
	SlackRedirectURI  *string `json:"slack_redirect_uri"`

	AIInsightsEnabled     *bool `json:"ai_insights_enabled"`
	WhatsAppIngestEnabled *bool `json:"whatsapp_ingest_enabled"`
	EmailIngestEnabled    *bool `json:"email_ingest_enabled"`
	RazorpayEnabled       *bool `json:"razorpay_integration_enabled"`
	StripeEnabled         *bool `json:"stripe_integration_enabled"`
	SlackIntegrationOn    *bool `json:"slack_integration_enabled"`
	NewSignupsEnabled     *bool `json:"new_signups_enabled"`
}

// HandleUpdatePlatformSettings mirrors PATCH /admin/settings — lets a
// platform admin change OAuth/integration provider credentials and
// global feature flags without touching Lambda env vars or redeploying.
// Secrets are encrypted (AES-256-GCM, same as bank account numbers)
// before being stored; a masked value ("••••••••") sent back unchanged
// is treated as "no change" rather than being encrypted literally.
func HandleUpdatePlatformSettings(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	var req updatePlatformSettingsRequest
	if !DecodeJSON(w, r, &req) {
		return
	}

	repo := repository.NewPlatformSettingsRepo()
	updated, err := repo.Update(r.Context(), tc.Tenant.OwnerEmail, func(item *repository.PlatformSettingsItem) {
		if req.GoogleClientID != nil {
			item.GoogleClientID = *req.GoogleClientID
		}
		if req.GoogleClientSecret != nil && *req.GoogleClientSecret != "" && *req.GoogleClientSecret != "••••••••" {
			if enc, encErr := security.EncryptField(*req.GoogleClientSecret); encErr == nil {
				item.GoogleClientSecretEnc = enc
			}
		}
		if req.GoogleRedirectURI != nil {
			item.GoogleRedirectURI = *req.GoogleRedirectURI
		}
		if req.AppleClientID != nil {
			item.AppleClientID = *req.AppleClientID
		}
		if req.AppleTeamID != nil {
			item.AppleTeamID = *req.AppleTeamID
		}
		if req.AppleKeyID != nil {
			item.AppleKeyID = *req.AppleKeyID
		}
		if req.ApplePrivateKey != nil && *req.ApplePrivateKey != "" && *req.ApplePrivateKey != "••••••••" {
			if enc, encErr := security.EncryptField(*req.ApplePrivateKey); encErr == nil {
				item.ApplePrivateKeyEnc = enc
			}
		}
		if req.AppleRedirectURI != nil {
			item.AppleRedirectURI = *req.AppleRedirectURI
		}
		if req.SlackClientID != nil {
			item.SlackClientID = *req.SlackClientID
		}
		if req.SlackClientSecret != nil && *req.SlackClientSecret != "" && *req.SlackClientSecret != "••••••••" {
			if enc, encErr := security.EncryptField(*req.SlackClientSecret); encErr == nil {
				item.SlackClientSecretEnc = enc
			}
		}
		if req.SlackRedirectURI != nil {
			item.SlackRedirectURI = *req.SlackRedirectURI
		}
		if req.AIInsightsEnabled != nil {
			item.AIInsightsEnabled = req.AIInsightsEnabled
		}
		if req.WhatsAppIngestEnabled != nil {
			item.WhatsAppIngestEnabled = req.WhatsAppIngestEnabled
		}
		if req.EmailIngestEnabled != nil {
			item.EmailIngestEnabled = req.EmailIngestEnabled
		}
		if req.RazorpayEnabled != nil {
			item.RazorpayIntegrationOn = req.RazorpayEnabled
		}
		if req.StripeEnabled != nil {
			item.StripeIntegrationOn = req.StripeEnabled
		}
		if req.SlackIntegrationOn != nil {
			item.SlackIntegrationOn = req.SlackIntegrationOn
		}
		if req.NewSignupsEnabled != nil {
			item.NewSignupsEnabled = req.NewSignupsEnabled
		}
	})
	if err != nil {
		slog.Error("update platform settings failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not update platform settings")
		return
	}

	slog.Info("platform settings updated", "updated_by", tc.Tenant.OwnerEmail)
	WriteJSON(w, http.StatusOK, platformSettingsOutFromItem(updated))
}

// ── Tenant overview ──────────────────────────────────────────────────────

type adminTenantOut struct {
	TenantID        string `json:"tenant_id"`
	BusinessName    string `json:"business_name"`
	OwnerEmail      string `json:"owner_email"`
	PlanTier        string `json:"plan_tier"`
	IsActive        bool   `json:"is_active"`
	IsPlatformAdmin bool   `json:"is_platform_admin"`
	CreatedAt       string `json:"created_at"`
}

// HandleListAllTenants mirrors GET /admin/tenants.
func HandleListAllTenants(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	repo := repository.NewTenantsRepo()
	tenants, err := repo.ListAll(r.Context(), 200)
	if err != nil {
		slog.Error("list all tenants failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not list tenants")
		return
	}
	out := make([]adminTenantOut, len(tenants))
	for i, t := range tenants {
		out[i] = adminTenantOut{
			TenantID: t.TenantID, BusinessName: t.BusinessName, OwnerEmail: t.OwnerEmail,
			PlanTier: t.PlanTier, IsActive: t.IsActive, IsPlatformAdmin: t.IsPlatformAdmin, CreatedAt: t.CreatedAt,
		}
	}
	WriteJSON(w, http.StatusOK, map[string]interface{}{"items": out, "total": len(out)})
}

type suspendTenantRequest struct {
	IsActive bool `json:"is_active"`
}

// HandleSetTenantActive mirrors PATCH /admin/tenants/{id}/active — lets
// an admin suspend or reactivate an account (e.g. for a billing issue or
// abuse report) without deleting any of their data.
func HandleSetTenantActive(w http.ResponseWriter, r *http.Request, tc *TenantContext, tenantID string) {
	var req suspendTenantRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	tenantsRepo := repository.NewTenantsRepo()
	updated, err := tenantsRepo.UpdateFields(r.Context(), tenantID, func(t *repository.TenantItem) {
		t.IsActive = req.IsActive
	})
	if err != nil {
		slog.Error("set tenant active failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not update tenant")
		return
	}
	slog.Info("tenant active status changed by admin", "tenant_id", tenantID, "is_active", req.IsActive, "admin", tc.Tenant.OwnerEmail)
	WriteJSON(w, http.StatusOK, adminTenantOut{
		TenantID: updated.TenantID, BusinessName: updated.BusinessName, OwnerEmail: updated.OwnerEmail,
		PlanTier: updated.PlanTier, IsActive: updated.IsActive, IsPlatformAdmin: updated.IsPlatformAdmin,
		CreatedAt: updated.CreatedAt,
	})
}

// ── System stats (basic — derived from DynamoDB, no CloudWatch API call
//    from this Lambda; see ADMIN_PANEL.md for the CloudWatch dashboard
//    this pairs with for the metrics that DynamoDB alone can't answer,
//    like error rates and latency) ────────────────────────────────────

type systemStatsOut struct {
	TotalTenants   int `json:"total_tenants"`
	ActiveTenants  int `json:"active_tenants"`
	SuspendedCount int `json:"suspended_count"`
}

// HandleGetSystemStats mirrors GET /admin/stats.
func HandleGetSystemStats(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	tenantsRepo := repository.NewTenantsRepo()
	tenants, err := tenantsRepo.ListAll(r.Context(), 500)
	if err != nil {
		slog.Error("get system stats failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not load system stats")
		return
	}
	active := 0
	for _, t := range tenants {
		if t.IsActive {
			active++
		}
	}
	WriteJSON(w, http.StatusOK, systemStatsOut{
		TotalTenants: len(tenants), ActiveTenants: active, SuspendedCount: len(tenants) - active,
	})
}
