package httpapi

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/marginpulse/backend/internal/config"
	"github.com/marginpulse/backend/internal/ratelimit"
	"github.com/marginpulse/backend/internal/repository"
	"github.com/marginpulse/backend/internal/security"
)

type registerRequest struct {
	BusinessName  string `json:"business_name"`
	Email         string `json:"email"`
	Password      string `json:"password"`
	CountryCode   string `json:"country_code"`
	WhatsAppPhone string `json:"whatsapp_phone"`
}

type loginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type refreshRequest struct {
	RefreshToken string `json:"refresh_token"`
}

type logoutRequest struct {
	RefreshToken string `json:"refresh_token"`
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TenantID     string `json:"tenant_id"`
	ExpiresIn    int    `json:"expires_in"`
}

type profileOut struct {
	TenantID             string `json:"tenant_id"`
	BusinessName         string `json:"business_name"`
	DisplayName          string `json:"display_name,omitempty"`
	OwnerEmail           string `json:"owner_email"`
	PhoneNumber          string `json:"phone_number,omitempty"`
	CountryCode          string `json:"country_code"`
	GSTINNumber          string `json:"gstin_number,omitempty"`
	GSTRegistered        bool   `json:"gst_registered"`
	WhatsAppBindingPhone string `json:"whatsapp_binding_phone,omitempty"`
	IngestEmailAlias     string `json:"ingest_email_alias,omitempty"`
	PlanTier             string `json:"plan_tier"`
	IsPlatformAdmin      bool   `json:"is_platform_admin"`
	CreatedAt            string `json:"created_at"`
}

func profileFromTenant(t *repository.TenantItem) profileOut {
	return profileOut{
		TenantID: t.TenantID, BusinessName: t.BusinessName, DisplayName: t.DisplayName,
		OwnerEmail: t.OwnerEmail, PhoneNumber: t.PhoneNumber, CountryCode: t.CountryCode,
		GSTINNumber: t.GSTINNumber, GSTRegistered: t.GSTRegistered,
		WhatsAppBindingPhone: t.WhatsAppBindingPhone, IngestEmailAlias: t.IngestEmailAlias,
		PlanTier: t.PlanTier, IsPlatformAdmin: t.IsPlatformAdmin, CreatedAt: t.CreatedAt,
	}
}

func ttlFromExp(claims *security.Claims) int64 {
	if claims.ExpiresAt == nil {
		return 0
	}
	remaining := int64(time.Until(claims.ExpiresAt.Time).Seconds())
	if remaining < 0 {
		return 0
	}
	return remaining
}

// HandleRegister mirrors POST /auth/register. Rate-limited 3/minute per IP.
func HandleRegister(w http.ResponseWriter, r *http.Request) {
	RateLimit(ratelimit.Limit{Count: 3, Window: time.Minute}, func(w http.ResponseWriter, r *http.Request) {
		var req registerRequest
		if !DecodeJSON(w, r, &req) {
			return
		}
		if len(req.Password) < security.MinPasswordLength {
			WriteError(w, http.StatusBadRequest, "password must be at least 8 characters")
			return
		}

		tenantsRepo := repository.NewTenantsRepo()
		if _, err := tenantsRepo.GetByEmail(r.Context(), req.Email); err == nil {
			// Generic message — do not confirm/deny which detail collided.
			WriteError(w, http.StatusConflict, "Registration could not be completed")
			return
		}

		pwHash, err := security.HashPassword(req.Password)
		if err != nil {
			WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		countryCode := strings.ToUpper(req.CountryCode)
		if len(countryCode) > 3 {
			countryCode = countryCode[:3]
		}
		if countryCode == "" {
			countryCode = "IND"
		}

		tenant, err := tenantsRepo.Create(r.Context(), repository.CreateTenantInput{
			BusinessName: req.BusinessName, OwnerEmail: req.Email, HashedPassword: pwHash,
			CountryCode: countryCode, WhatsAppBindingPhone: req.WhatsAppPhone,
		})
		if err != nil {
			slog.Error("register failed", "error", err)
			WriteError(w, http.StatusInternalServerError, "Registration failed")
			return
		}

		access, _ := security.CreateAccessToken(tenant.OwnerEmail, tenant.TenantID)
		refresh, _ := security.CreateRefreshToken(tenant.OwnerEmail, tenant.TenantID)
		slog.Info("new tenant registered", "tenant_id", tenant.TenantID)
		WriteJSON(w, http.StatusCreated, tokenResponse{AccessToken: access, RefreshToken: refresh, TenantID: tenant.TenantID, ExpiresIn: config.Get().JWTAccessTokenExpireMinutes * 60})
	})(w, r)
}

// HandleLogin mirrors POST /auth/login. Rate-limited 5/minute per IP.
// Always runs bcrypt (against a dummy hash if no tenant is found) so
// response timing doesn't leak whether an email is registered.
func HandleLogin(w http.ResponseWriter, r *http.Request) {
	RateLimit(ratelimit.Limit{Count: 5, Window: time.Minute}, func(w http.ResponseWriter, r *http.Request) {
		var req loginRequest
		if !DecodeJSON(w, r, &req) {
			return
		}

		tenantsRepo := repository.NewTenantsRepo()
		tenant, err := tenantsRepo.GetByEmail(r.Context(), req.Email)

		hashToCheck := security.DummyHash
		if err == nil {
			hashToCheck = tenant.HashedPassword
		}
		passwordOK := security.VerifyPassword(req.Password, hashToCheck)

		if err != nil || !passwordOK {
			slog.Warn("failed login attempt", "email", req.Email)
			WriteError(w, http.StatusUnauthorized, "Invalid credentials")
			return
		}
		if !tenant.IsActive {
			WriteError(w, http.StatusForbidden, "Account suspended")
			return
		}

		access, _ := security.CreateAccessToken(tenant.OwnerEmail, tenant.TenantID)
		refresh, _ := security.CreateRefreshToken(tenant.OwnerEmail, tenant.TenantID)
		WriteJSON(w, http.StatusOK, tokenResponse{AccessToken: access, RefreshToken: refresh, TenantID: tenant.TenantID, ExpiresIn: config.Get().JWTAccessTokenExpireMinutes * 60})
	})(w, r)
}

// HandleRefresh mirrors POST /auth/refresh. Rate-limited 10/minute per
// IP. Rotates the refresh token: the old one is revoked the moment it's
// exchanged, so a leaked refresh token can't be replayed after a
// legitimate refresh has happened.
func HandleRefresh(w http.ResponseWriter, r *http.Request) {
	RateLimit(ratelimit.Limit{Count: 10, Window: time.Minute}, func(w http.ResponseWriter, r *http.Request) {
		var req refreshRequest
		if !DecodeJSON(w, r, &req) {
			return
		}

		claims, err := security.DecodeToken(req.RefreshToken)
		if err != nil {
			WriteError(w, http.StatusUnauthorized, "Invalid or expired refresh token")
			return
		}
		if claims.Type != "refresh" {
			WriteError(w, http.StatusUnauthorized, "Not a refresh token")
			return
		}

		tenantsRepo := repository.NewTenantsRepo()
		tenant, err := tenantsRepo.GetByID(r.Context(), claims.TenantID)
		if err != nil || !tenant.IsActive {
			WriteError(w, http.StatusUnauthorized, "Tenant not found or inactive")
			return
		}

		security.RevokeToken(r.Context(), claims.JTI, ttlFromExp(claims))

		newAccess, _ := security.CreateAccessToken(claims.Subject, claims.TenantID)
		newRefresh, _ := security.CreateRefreshToken(claims.Subject, claims.TenantID)
		WriteJSON(w, http.StatusOK, tokenResponse{AccessToken: newAccess, RefreshToken: newRefresh, TenantID: claims.TenantID, ExpiresIn: config.Get().JWTAccessTokenExpireMinutes * 60})
	})(w, r)
}

// HandleLogout mirrors POST /auth/logout. Revokes the current access
// token and, if provided, the refresh token too.
func HandleLogout(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	RateLimit(ratelimit.Limit{Count: 20, Window: time.Minute}, func(w http.ResponseWriter, r *http.Request) {
		var req logoutRequest
		_ = DecodeJSONOptional(r, &req)

		security.RevokeToken(r.Context(), tc.Claims.JTI, ttlFromExp(tc.Claims))

		if req.RefreshToken != "" {
			if rtClaims, err := security.DecodeToken(req.RefreshToken); err == nil {
				if rtClaims.TenantID == tc.Tenant.TenantID {
					security.RevokeToken(r.Context(), rtClaims.JTI, ttlFromExp(rtClaims))
				}
			}
		}

		slog.Info("tenant logged out", "tenant_id", tc.Tenant.TenantID)
		WriteJSON(w, http.StatusOK, errorBody{Detail: "Logged out successfully"})
	})(w, r)
}

// HandleGetProfile mirrors GET /auth/me.
func HandleGetProfile(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	WriteJSON(w, http.StatusOK, profileFromTenant(tc.Tenant))
}

type profileUpdateRequest struct {
	BusinessName         *string `json:"business_name"`
	DisplayName          *string `json:"display_name"`
	PhoneNumber          *string `json:"phone_number"`
	WhatsAppBindingPhone *string `json:"whatsapp_binding_phone"`
	IngestEmailAlias     *string `json:"ingest_email_alias"`
}

// HandleUpdateProfile mirrors PATCH /auth/me — true partial update, only
// fields present in the JSON body are changed.
func HandleUpdateProfile(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	RateLimit(ratelimit.Limit{Count: 20, Window: time.Minute}, func(w http.ResponseWriter, r *http.Request) {
		var req profileUpdateRequest
		if !DecodeJSON(w, r, &req) {
			return
		}

		tenantsRepo := repository.NewTenantsRepo()
		updatedFields := []string{}
		updated, err := tenantsRepo.UpdateFields(r.Context(), tc.Tenant.TenantID, func(t *repository.TenantItem) {
			if req.BusinessName != nil {
				t.BusinessName = *req.BusinessName
				updatedFields = append(updatedFields, "business_name")
			}
			if req.DisplayName != nil {
				t.DisplayName = *req.DisplayName
				updatedFields = append(updatedFields, "display_name")
			}
			if req.PhoneNumber != nil {
				t.PhoneNumber = *req.PhoneNumber
				updatedFields = append(updatedFields, "phone_number")
			}
			if req.WhatsAppBindingPhone != nil {
				t.WhatsAppBindingPhone = *req.WhatsAppBindingPhone
				updatedFields = append(updatedFields, "whatsapp_binding_phone")
			}
			if req.IngestEmailAlias != nil {
				t.IngestEmailAlias = *req.IngestEmailAlias
				updatedFields = append(updatedFields, "ingest_email_alias")
			}
		})
		if err != nil {
			slog.Error("profile update failed", "error", err)
			WriteError(w, http.StatusInternalServerError, "Update failed")
			return
		}

		slog.Info("tenant profile updated", "tenant_id", tc.Tenant.TenantID, "fields", updatedFields)
		WriteJSON(w, http.StatusOK, profileFromTenant(updated))
	})(w, r)
}

type changePasswordRequest struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

// HandleChangePassword mirrors POST /auth/change-password.
func HandleChangePassword(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	RateLimit(ratelimit.Limit{Count: 5, Window: time.Minute}, func(w http.ResponseWriter, r *http.Request) {
		var req changePasswordRequest
		if !DecodeJSON(w, r, &req) {
			return
		}

		if !security.VerifyPassword(req.CurrentPassword, tc.Tenant.HashedPassword) {
			WriteError(w, http.StatusUnauthorized, "Current password is incorrect")
			return
		}

		newHash, err := security.HashPassword(req.NewPassword)
		if err != nil {
			WriteError(w, http.StatusBadRequest, err.Error())
			return
		}

		tenantsRepo := repository.NewTenantsRepo()
		_, err = tenantsRepo.UpdateFields(r.Context(), tc.Tenant.TenantID, func(t *repository.TenantItem) {
			t.HashedPassword = newHash
		})
		if err != nil {
			slog.Error("change password failed", "error", err)
			WriteError(w, http.StatusInternalServerError, "Could not change password")
			return
		}

		security.RevokeToken(r.Context(), tc.Claims.JTI, ttlFromExp(tc.Claims))

		slog.Info("tenant changed password", "tenant_id", tc.Tenant.TenantID)
		WriteJSON(w, http.StatusOK, errorBody{Detail: "Password changed successfully. Please log in again."})
	})(w, r)
}

// DecodeJSONOptional decodes a JSON body but doesn't fail the request if
// it's empty/absent — used by logout, whose refresh_token field is
// optional and callers sometimes send an empty body entirely.
func DecodeJSONOptional(r *http.Request, dst interface{}) error {
	defer r.Body.Close()
	err := decodeJSONBody(r, dst)
	if err != nil && !errors.Is(err, errEmptyBody) {
		return err
	}
	return nil
}
