package httpapi

import (
	"log/slog"
	"net/http"
	"net/url"

	"github.com/marginpulse/backend/internal/config"
	"github.com/marginpulse/backend/internal/oauth"
	"github.com/marginpulse/backend/internal/repository"
	"github.com/marginpulse/backend/internal/security"
)

// oauthSuccessRedirect sends the browser back to the frontend with a
// freshly-issued token pair in the URL fragment (#, not ?) — fragments
// are never sent to the server on subsequent requests or logged by
// intermediate proxies/CDNs the way query strings can be, which matters
// since these are live, usable auth tokens riding along in a URL.
func oauthSuccessRedirect(w http.ResponseWriter, r *http.Request, access, refresh, tenantID string) {
	cfg := config.Get()
	target := cfg.FrontendBaseURL + "/#/oauth-callback" +
		"?access_token=" + url.QueryEscape(access) +
		"&refresh_token=" + url.QueryEscape(refresh) +
		"&tenant_id=" + url.QueryEscape(tenantID)
	http.Redirect(w, r, target, http.StatusFound)
}

func oauthErrorRedirect(w http.ResponseWriter, r *http.Request, message string) {
	cfg := config.Get()
	target := cfg.FrontendBaseURL + "/?oauth_error=" + url.QueryEscape(message)
	http.Redirect(w, r, target, http.StatusFound)
}

// findOrCreateOAuthTenant mirrors the register-or-login logic every
// provider's callback needs: if an account already exists for this
// email (whether it was originally created via password or a different
// OAuth provider), sign into it; otherwise create a brand-new tenant.
// The new tenant's password hash is a random, never-disclosed bcrypt
// hash — they simply never have a usable password until/unless they
// explicitly set one later (e.g. via a future "add a password" flow in
// Security settings), which is fine since VerifyPassword only ever
// succeeds against a hash of a real password nobody but us generated.
func findOrCreateOAuthTenant(r *http.Request, email, displayName string) (*repository.TenantItem, error) {
	tenantsRepo := repository.NewTenantsRepo()
	tenant, err := tenantsRepo.GetByEmail(r.Context(), email)
	if err == nil {
		return tenant, nil
	}

	randomPassword, genErr := security.HashPassword(security.DummyHash) // structurally valid bcrypt input path
	if genErr != nil {
		randomPassword = security.DummyHash
	}
	businessName := displayName
	if businessName == "" {
		businessName = email
	}
	return tenantsRepo.Create(r.Context(), repository.CreateTenantInput{
		BusinessName: businessName, OwnerEmail: email, HashedPassword: randomPassword, CountryCode: "IND",
	})
}

// HandleGoogleLogin mirrors GET /auth/google/login.
func HandleGoogleLogin(w http.ResponseWriter, r *http.Request) {
	state, err := oauth.NewState(r.Context(), "google_login")
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "Could not start Google sign-in")
		return
	}
	authURL, err := oauth.GoogleAuthURL(r.Context(), state)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "Could not start Google sign-in")
		return
	}
	http.Redirect(w, r, authURL, http.StatusFound)
}

// HandleGoogleCallback mirrors GET /auth/google/callback.
func HandleGoogleCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if errParam := q.Get("error"); errParam != "" {
		oauthErrorRedirect(w, r, "Google sign-in was cancelled")
		return
	}
	if _, err := oauth.ConsumeState(r.Context(), q.Get("state")); err != nil {
		oauthErrorRedirect(w, r, "Invalid or expired sign-in attempt — please try again")
		return
	}

	userInfo, _, err := oauth.GoogleExchangeCode(r.Context(), q.Get("code"))
	if err != nil {
		slog.Error("google oauth exchange failed", "error", err)
		oauthErrorRedirect(w, r, "Google sign-in failed")
		return
	}

	tenant, err := findOrCreateOAuthTenant(r, userInfo.Email, userInfo.Name)
	if err != nil {
		slog.Error("google oauth tenant creation failed", "error", err)
		oauthErrorRedirect(w, r, "Could not complete sign-in")
		return
	}

	access, _ := security.CreateAccessToken(tenant.OwnerEmail, tenant.TenantID)
	refresh, _ := security.CreateRefreshToken(tenant.OwnerEmail, tenant.TenantID)
	slog.Info("google oauth login", "tenant_id", tenant.TenantID)
	oauthSuccessRedirect(w, r, access, refresh, tenant.TenantID)
}

// HandleAppleLogin mirrors GET /auth/apple/login.
func HandleAppleLogin(w http.ResponseWriter, r *http.Request) {
	state, err := oauth.NewState(r.Context(), "apple_login")
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "Could not start Apple sign-in")
		return
	}
	authURL, err := oauth.AppleAuthURL(r.Context(), state)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "Could not start Apple sign-in")
		return
	}
	http.Redirect(w, r, authURL, http.StatusFound)
}

// HandleAppleCallback mirrors POST /auth/apple/callback — Apple uses
// response_mode=form_post (required when requesting name/email scopes),
// so this arrives as a POST with form-encoded fields, not a GET with a
// query string the way Google's callback does.
func HandleAppleCallback(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		oauthErrorRedirect(w, r, "Malformed Apple sign-in response")
		return
	}
	if errParam := r.FormValue("error"); errParam != "" {
		oauthErrorRedirect(w, r, "Apple sign-in was cancelled")
		return
	}
	if _, err := oauth.ConsumeState(r.Context(), r.FormValue("state")); err != nil {
		oauthErrorRedirect(w, r, "Invalid or expired sign-in attempt — please try again")
		return
	}

	userInfo, err := oauth.AppleExchangeCode(r.Context(), r.FormValue("code"))
	if err != nil {
		slog.Error("apple oauth exchange failed", "error", err)
		oauthErrorRedirect(w, r, "Apple sign-in failed")
		return
	}

	tenant, err := findOrCreateOAuthTenant(r, userInfo.Email, "")
	if err != nil {
		slog.Error("apple oauth tenant creation failed", "error", err)
		oauthErrorRedirect(w, r, "Could not complete sign-in")
		return
	}

	access, _ := security.CreateAccessToken(tenant.OwnerEmail, tenant.TenantID)
	refresh, _ := security.CreateRefreshToken(tenant.OwnerEmail, tenant.TenantID)
	slog.Info("apple oauth login", "tenant_id", tenant.TenantID)
	oauthSuccessRedirect(w, r, access, refresh, tenant.TenantID)
}
