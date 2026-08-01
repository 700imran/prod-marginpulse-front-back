package httpapi

import (
	"net/http"
	"strconv"

	"github.com/marginpulse/backend/internal/repository"
)

type auditLogOut struct {
	AuditLogID string `json:"audit_log_id"`
	EntityType string `json:"entity_type"`
	EntityID   string `json:"entity_id"`
	Action     string `json:"action"`
	FieldName  string `json:"field_name,omitempty"`
	OldValue   string `json:"old_value,omitempty"`
	NewValue   string `json:"new_value,omitempty"`
	Reason     string `json:"reason,omitempty"`
	ActorEmail string `json:"actor_email,omitempty"`
	CreatedAt  string `json:"created_at"`
}

func auditLogOutFromItem(a repository.AuditLogItem) auditLogOut {
	return auditLogOut{
		AuditLogID: a.AuditLogID, EntityType: a.EntityType, EntityID: a.EntityID,
		Action: a.Action, FieldName: a.FieldName, OldValue: a.OldValue, NewValue: a.NewValue,
		Reason: a.Reason, ActorEmail: a.ActorEmail, CreatedAt: a.CreatedAt,
	}
}

// HandleListAuditLog mirrors GET /audit-log — the tenant-wide audit
// trail, optionally filtered with ?entity_type=DOCUMENT&entity_id=<id>
// to see just one document's (or bank transaction's) history. Also
// reachable as GET /documents/{id}/audit-log, which is just this same
// handler with entity_type/entity_id pre-filled from the path.
func HandleListAuditLog(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	q := r.URL.Query()
	limit := int32(100)
	if l, err := strconv.Atoi(q.Get("limit")); err == nil && l > 0 {
		limit = int32(l)
	}

	auditRepo := repository.NewAuditLogsRepo()
	items, err := auditRepo.ListByTenant(r.Context(), tc.Tenant.TenantID, q.Get("entity_type"), q.Get("entity_id"), limit)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "Could not load audit log")
		return
	}
	out := make([]auditLogOut, len(items))
	for i, a := range items {
		out[i] = auditLogOutFromItem(a)
	}
	WriteJSON(w, http.StatusOK, map[string]interface{}{"items": out})
}

// HandleGetDocumentAuditLog mirrors GET /documents/{id}/audit-log.
func HandleGetDocumentAuditLog(w http.ResponseWriter, r *http.Request, tc *TenantContext, documentID string) {
	auditRepo := repository.NewAuditLogsRepo()
	items, err := auditRepo.ListByTenant(r.Context(), tc.Tenant.TenantID, "DOCUMENT", documentID, 200)
	if err != nil {
		WriteError(w, http.StatusInternalServerError, "Could not load document audit log")
		return
	}
	out := make([]auditLogOut, len(items))
	for i, a := range items {
		out[i] = auditLogOutFromItem(a)
	}
	WriteJSON(w, http.StatusOK, map[string]interface{}{"items": out})
}
