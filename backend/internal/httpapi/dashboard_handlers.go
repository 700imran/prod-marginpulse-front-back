package httpapi

import (
	"log/slog"
	"net/http"

	"github.com/marginpulse/backend/internal/pipelines/dashboard"
)

// HandleDashboardInsights mirrors GET /dashboard/insights — the
// product's default daily dashboard per the roadmap: highest ITC risk
// today, vendors requiring follow-up, upcoming filing deadlines, and
// estimated recoverable ITC. This sits alongside (not instead of)
// HandleDashboardSummary's mismatch-count view in
// reconciliation_handlers.go.
func HandleDashboardInsights(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	result, err := dashboard.Build(r.Context(), tc.Tenant.TenantID)
	if err != nil {
		slog.Error("dashboard insights: build failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not load dashboard insights")
		return
	}
	WriteJSON(w, http.StatusOK, result)
}
