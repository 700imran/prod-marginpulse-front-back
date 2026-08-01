// Package httpapi implements the HTTP layer using Go 1.22's
// pattern-based net/http.ServeMux (no external router dependency
// needed) — ported from main.py + app/api/v1/deps.py +
// app/api/v1/endpoints/*.py.
package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"github.com/marginpulse/backend/internal/config"
	"github.com/marginpulse/backend/internal/logging"
	"github.com/marginpulse/backend/internal/ratelimit"
	"github.com/marginpulse/backend/internal/repository"
	"github.com/marginpulse/backend/internal/security"
)

type ctxKey string

const tenantCtxKey ctxKey = "tenant"

// TenantContext carries the authenticated tenant + the raw JWT claims
// (jti needed for logout revocation) through a request — the Go
// equivalent of FastAPI's get_current_tenant() dependency injection.
type TenantContext struct {
	Tenant *repository.TenantItem
	Claims *security.Claims
}

func TenantFromContext(ctx context.Context) (*TenantContext, bool) {
	tc, ok := ctx.Value(tenantCtxKey).(*TenantContext)
	return tc, ok
}

func withTenant(ctx context.Context, tc *TenantContext) context.Context {
	return context.WithValue(ctx, tenantCtxKey, tc)
}

func newRequestID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// RequestIDMiddleware mirrors main.py's request_context_and_access_log —
// binds a request ID, logs one structured access-log line per request.
func RequestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := r.Header.Get("X-Request-ID")
		if requestID == "" {
			requestID = newRequestID()
		}
		ctx, logger := logging.WithRequestID(r.Context(), requestID)
		start := time.Now()

		sw := &statusWriter{ResponseWriter: w, status: 200}
		w.Header().Set("X-Request-ID", requestID)

		next.ServeHTTP(sw, r.WithContext(ctx))

		duration := time.Since(start)
		logFn := logger.Info
		if sw.status >= 400 {
			logFn = logger.Warn
		}
		logFn("request_completed",
			"method", r.Method, "path", r.URL.Path,
			"status_code", sw.status, "duration_ms", duration.Milliseconds(),
			"client_ip", ratelimit.ClientIP(r),
		)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

// SecurityHeadersMiddleware mirrors main.py's security headers middleware.
func SecurityHeadersMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
		if config.Get().AppEnv == "production" {
			h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

// CORSMiddleware mirrors main.py's CORSMiddleware(allow_origins=cors_origins).
func CORSMiddleware(next http.Handler) http.Handler {
	allowed := config.Get().AllowedOrigins
	allowedSet := map[string]bool{}
	for _, o := range allowed {
		allowedSet[strings.TrimSpace(o)] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && (allowedSet["*"] || allowedSet[origin]) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-ID")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireAuth mirrors get_current_tenant() — validates the Bearer JWT,
// checks the revocation blocklist, loads the tenant, and rejects
// inactive accounts. Wraps a handler that needs an authenticated tenant.
func RequireAuth(next func(w http.ResponseWriter, r *http.Request, tc *TenantContext)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			WriteError(w, http.StatusUnauthorized, "Not authenticated")
			return
		}
		tokenString := strings.TrimPrefix(authHeader, "Bearer ")

		claims, err := security.DecodeToken(tokenString)
		if err != nil {
			WriteError(w, http.StatusUnauthorized, "Invalid or expired token")
			return
		}
		if claims.Type != "access" {
			WriteError(w, http.StatusUnauthorized, "Invalid token type")
			return
		}
		if security.IsRevoked(r.Context(), claims.JTI) {
			WriteError(w, http.StatusUnauthorized, "Token has been revoked")
			return
		}

		tenantsRepo := repository.NewTenantsRepo()
		tenant, err := tenantsRepo.GetByID(r.Context(), claims.TenantID)
		if err != nil {
			WriteError(w, http.StatusUnauthorized, "Account not found")
			return
		}
		if !tenant.IsActive {
			WriteError(w, http.StatusForbidden, "Account is deactivated")
			return
		}

		tc := &TenantContext{Tenant: tenant, Claims: claims}
		ctx := withTenant(r.Context(), tc)
		next(w, r.WithContext(ctx), tc)
	}
}

// RequirePlatformAdmin wraps RequireAuth with an additional check that
// the authenticated tenant is flagged as a platform admin — used for
// every /api/v1/admin/* route. Deliberately checked AFTER full JWT
// validation (not as a replacement for it), so admin routes get the
// exact same token-revocation/expiry/active-account checks as every
// other authenticated route, plus this one extra gate.
func RequirePlatformAdmin(next func(w http.ResponseWriter, r *http.Request, tc *TenantContext)) http.HandlerFunc {
	return RequireAuth(func(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
		if !tc.Tenant.IsPlatformAdmin {
			WriteError(w, http.StatusForbidden, "Platform admin access required")
			return
		}
		next(w, r, tc)
	})
}
func RateLimit(limit ratelimit.Limit, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := r.URL.Path + ":" + ratelimit.ClientIP(r)
		result := ratelimit.Check(r.Context(), key, limit)
		ratelimit.SetHeaders(w, result)
		if !result.Allowed {
			w.Header().Set("Retry-After", "60")
			WriteError(w, http.StatusTooManyRequests, "Rate limit exceeded — please try again shortly")
			return
		}
		next(w, r)
	}
}
