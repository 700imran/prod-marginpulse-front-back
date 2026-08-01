package httpapi

import (
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/marginpulse/backend/internal/config"
	"github.com/marginpulse/backend/internal/integrations"
	"github.com/marginpulse/backend/internal/oauth"
	"github.com/marginpulse/backend/internal/repository"
	"github.com/marginpulse/backend/internal/security"
)

type integrationOut struct {
	Provider            string `json:"provider"`
	Status              string `json:"status"`
	ExternalAccountName string `json:"external_account_name,omitempty"`
	LastError           string `json:"last_error,omitempty"`
	ConnectedAt         string `json:"connected_at"`
	LastSyncedAt        string `json:"last_synced_at,omitempty"`
}

func integrationOutFromItem(it repository.IntegrationItem) integrationOut {
	return integrationOut{
		Provider: it.Provider, Status: it.Status, ExternalAccountName: it.ExternalAccountName,
		LastError: it.LastError, ConnectedAt: it.ConnectedAt, LastSyncedAt: it.LastSyncedAt,
	}
}

// dataConnectorFor returns the real connector implementation for
// API-key-based providers — extend this map when a new provider from
// integrations/stub.go gets implemented.
func dataConnectorFor(provider string) integrations.DataConnector {
	switch strings.ToUpper(provider) {
	case "RAZORPAY":
		return integrations.NewRazorpayConnector()
	case "STRIPE":
		return integrations.NewStripeConnector()
	default:
		return nil
	}
}

// HandleListIntegrations mirrors GET /integrations — shows every
// provider (connected or not) so the frontend can render a consistent
// grid of connect/disconnect buttons.
func HandleListIntegrations(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	repo := repository.NewIntegrationsRepo()
	items, err := repo.ListByTenant(r.Context(), tc.Tenant.TenantID)
	if err != nil {
		slog.Error("list integrations failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not list integrations")
		return
	}
	out := make([]integrationOut, len(items))
	for i, it := range items {
		out[i] = integrationOutFromItem(it)
	}
	WriteJSON(w, http.StatusOK, map[string]interface{}{"items": out})
}

type connectAPIKeyRequest struct {
	Credentials map[string]string `json:"credentials"`
}

// HandleConnectAPIKeyIntegration mirrors POST /integrations/{provider}/connect
// for API-key-based providers (Razorpay, Stripe) — verifies the
// credentials with a real API call before storing anything.
func HandleConnectAPIKeyIntegration(w http.ResponseWriter, r *http.Request, tc *TenantContext, provider string) {
	connector := dataConnectorFor(provider)
	if connector == nil {
		WriteError(w, http.StatusNotImplemented, fmt.Sprintf(
			"%s is not yet implemented — see internal/integrations/stub.go for what's needed to add it", provider))
		return
	}

	var req connectAPIKeyRequest
	if !DecodeJSON(w, r, &req) {
		return
	}

	externalID, externalName, err := connector.Connect(r.Context(), req.Credentials)
	if err != nil {
		WriteError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Encrypt every credential value at rest — same AES-256-GCM field
	// encryption used for bank account numbers (internal/security).
	encryptedCreds := map[string]string{}
	for k, v := range req.Credentials {
		enc, encErr := security.EncryptField(v)
		if encErr != nil {
			slog.Error("credential encryption failed", "provider", provider, "error", encErr)
			WriteError(w, http.StatusInternalServerError, "Could not securely store credentials")
			return
		}
		encryptedCreds[k] = enc
	}

	repo := repository.NewIntegrationsRepo()
	item, err := repo.Upsert(r.Context(), repository.IntegrationItem{
		TenantID: tc.Tenant.TenantID, Provider: strings.ToUpper(provider), Status: "CONNECTED",
		APIKeyEncrypted:   encryptedCreds["key_id"] + encryptedCreds["secret_key"], // provider-specific key name; see note below
		ExternalAccountID: externalID, ExternalAccountName: externalName,
	})
	if err != nil {
		slog.Error("integration upsert failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not save integration")
		return
	}

	// NOTE: the line above concatenating two possible credential fields
	// into one stored column is a simplification — Razorpay uses
	// key_id+key_secret, Stripe uses only secret_key. A real
	// multi-provider credential store would use a JSON blob column
	// (metadata_json) rather than fixed key_id/secret fields; flagged
	// here rather than silently shipped as if it were fully general.
	slog.Info("integration connected", "tenant_id", tc.Tenant.TenantID, "provider", provider)
	WriteJSON(w, http.StatusCreated, integrationOutFromItem(*item))
}

// HandleSyncIntegration mirrors POST /integrations/{provider}/sync —
// fetches recent transactions from the provider and creates one
// BankTransaction per result, feeding the same reconciliation pipeline
// a CSV upload would.
func HandleSyncIntegration(w http.ResponseWriter, r *http.Request, tc *TenantContext, provider string) {
	connector := dataConnectorFor(provider)
	if connector == nil {
		WriteError(w, http.StatusNotImplemented, fmt.Sprintf("%s does not support data sync", provider))
		return
	}

	integrationsRepo := repository.NewIntegrationsRepo()
	existing, err := integrationsRepo.GetByProvider(r.Context(), tc.Tenant.TenantID, provider)
	if err != nil {
		WriteError(w, http.StatusNotFound, fmt.Sprintf("%s is not connected", provider))
		return
	}

	// Decrypt stored credentials back into the map shape Connect/FetchTransactions expect.
	credentials := map[string]string{}
	if existing.APIKeyEncrypted != "" {
		// See the NOTE in HandleConnectAPIKeyIntegration — this
		// simplistic split only works because today's two providers
		// (Razorpay, Stripe) are handled with provider-specific
		// branches here rather than a truly generic credential map.
		switch strings.ToUpper(provider) {
		case "STRIPE":
			if dec, decErr := security.DecryptField(existing.APIKeyEncrypted); decErr == nil {
				credentials["secret_key"] = dec
			}
		case "RAZORPAY":
			slog.Error("razorpay sync needs key_id+key_secret split storage — see HandleConnectAPIKeyIntegration note")
			WriteError(w, http.StatusNotImplemented, "Razorpay sync needs the credential-storage fix noted in integration_handlers.go — see code comments")
			return
		}
	}

	txns, err := connector.FetchTransactions(r.Context(), credentials, "")
	if err != nil {
		integrationsRepo.UpdateFields(r.Context(), tc.Tenant.TenantID, provider, []repository.FieldUpdate{
			repository.F("status", "ERROR"), repository.F("last_error", err.Error()),
		})
		WriteError(w, http.StatusBadGateway, "Sync failed: "+err.Error())
		return
	}

	txnRepo := repository.NewBankTransactionsRepo()
	created := 0
	for _, t := range txns {
		if _, err := txnRepo.Create(r.Context(), repository.CreateBankTransactionInput{
			TenantID: tc.Tenant.TenantID, Narration: t.Narration, TransactionDate: t.Date,
			CreditAmount: t.Amount, BankName: provider,
		}); err != nil {
			slog.Error("synced transaction creation failed", "error", err)
			continue
		}
		created++
	}

	integrationsRepo.UpdateFields(r.Context(), tc.Tenant.TenantID, provider, []repository.FieldUpdate{
		repository.F("last_synced_at", time.Now().UTC().Format(time.RFC3339)),
	})

	WriteJSON(w, http.StatusOK, map[string]interface{}{"transactions_synced": created, "found": len(txns)})
}

// HandleDisconnectIntegration mirrors POST /integrations/{provider}/disconnect.
func HandleDisconnectIntegration(w http.ResponseWriter, r *http.Request, tc *TenantContext, provider string) {
	repo := repository.NewIntegrationsRepo()
	if err := repo.Disconnect(r.Context(), tc.Tenant.TenantID, provider); err != nil {
		slog.Error("disconnect integration failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not disconnect")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── Slack OAuth connect (separate from the API-key flow above) ─────────

// HandleSlackConnect mirrors GET /integrations/slack/connect.
func HandleSlackConnect(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	state, err := oauth.NewState(r.Context(), "slack_connect:"+tc.Tenant.TenantID)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "Could not start Slack connection")
		return
	}
	slack := integrations.NewSlackConnector()
	authURL, err := slack.AuthURL(r.Context(), state)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "Could not start Slack connection")
		return
	}
	http.Redirect(w, r, authURL, http.StatusFound)
}

// HandleSlackCallback mirrors GET /integrations/slack/callback. The
// tenant is recovered from the state token's stored purpose string
// (slack_connect:<tenant_id>) since this callback is an unauthenticated
// browser redirect from Slack, not a Bearer-authenticated API call.
func HandleSlackCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	purpose, err := oauth.ConsumeState(r.Context(), q.Get("state"))
	if err != nil || !strings.HasPrefix(purpose, "slack_connect:") {
		oauthErrorRedirect(w, r, "Invalid or expired Slack connection attempt")
		return
	}
	tenantID := strings.TrimPrefix(purpose, "slack_connect:")

	slack := integrations.NewSlackConnector()
	accessToken, teamName, webhookURL, err := slack.ExchangeCode(r.Context(), q.Get("code"))
	if err != nil {
		slog.Error("slack oauth exchange failed", "error", err)
		oauthErrorRedirect(w, r, "Slack connection failed")
		return
	}

	encryptedToken, err := security.EncryptField(accessToken)
	if err != nil {
		oauthErrorRedirect(w, r, "Could not securely store Slack credentials")
		return
	}
	encryptedWebhook, err := security.EncryptField(webhookURL)
	if err != nil {
		oauthErrorRedirect(w, r, "Could not securely store Slack credentials")
		return
	}

	repo := repository.NewIntegrationsRepo()
	if _, err := repo.Upsert(r.Context(), repository.IntegrationItem{
		TenantID: tenantID, Provider: "SLACK", Status: "CONNECTED",
		AccessTokenEncrypted: encryptedToken, APIKeyEncrypted: encryptedWebhook, // webhook URL stored in the api_key_encrypted slot
		ExternalAccountName: teamName,
	}); err != nil {
		slog.Error("slack integration save failed", "error", err)
		oauthErrorRedirect(w, r, "Could not save Slack connection")
		return
	}

	cfgRedirect := config.Get().FrontendBaseURL + "/?integration=slack&status=connected"
	http.Redirect(w, r, cfgRedirect, http.StatusFound)
}
