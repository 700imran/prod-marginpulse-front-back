package httpapi

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/marginpulse/backend/internal/queue"
	"github.com/marginpulse/backend/internal/repository"
)

type taxIdentifierOut struct {
	TaxIdentifierID    string `json:"tax_identifier_id"`
	IDType             string `json:"id_type"`
	IDValue            string `json:"id_value"`
	Label              string `json:"label,omitempty"`
	VerificationStatus string `json:"verification_status"`
	VerifiedLegalName  string `json:"verified_legal_name,omitempty"`
	VerificationError  string `json:"verification_error,omitempty"`
	IsPrimary          bool   `json:"is_primary"`
	CreatedAt          string `json:"created_at"`
}

func taxIdentifierOutFromItem(t repository.TaxIdentifierItem) taxIdentifierOut {
	return taxIdentifierOut{
		TaxIdentifierID: t.TaxIdentifierID, IDType: t.IDType, IDValue: t.IDValue, Label: t.Label,
		VerificationStatus: t.VerificationStatus, VerifiedLegalName: t.VerifiedLegalName,
		VerificationError: t.VerificationError, IsPrimary: t.IsPrimary, CreatedAt: t.CreatedAt,
	}
}

// HandleListTaxIdentifiers mirrors GET /tax-identifiers.
func HandleListTaxIdentifiers(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	repo := repository.NewTaxIdentifiersRepo()
	items, err := repo.ListByTenant(r.Context(), tc.Tenant.TenantID)
	if err != nil {
		slog.Error("list tax identifiers failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not list tax identifiers")
		return
	}
	out := make([]taxIdentifierOut, len(items))
	for i, t := range items {
		out[i] = taxIdentifierOutFromItem(t)
	}
	WriteJSON(w, http.StatusOK, out)
}

type createTaxIdentifierRequest struct {
	IDType  string `json:"id_type"`
	IDValue string `json:"id_value"`
	Label   string `json:"label"`
}

// HandleCreateTaxIdentifier mirrors POST /tax-identifiers — creates the
// record then immediately queues async verification.
func HandleCreateTaxIdentifier(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	var req createTaxIdentifierRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if req.IDType == "" || req.IDValue == "" {
		WriteError(w, http.StatusBadRequest, "id_type and id_value are required")
		return
	}

	repo := repository.NewTaxIdentifiersRepo()
	item, err := repo.Create(r.Context(), repository.CreateTaxIdentifierInput{
		TenantID: tc.Tenant.TenantID, IDType: req.IDType, IDValue: req.IDValue, Label: req.Label,
	})
	if err != nil {
		if errors.Is(err, repository.ErrDuplicateTaxIdentifier) {
			WriteError(w, http.StatusConflict, err.Error())
			return
		}
		slog.Error("create tax identifier failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not create tax identifier")
		return
	}

	if _, err := queue.EnqueueTaxIdentifierVerification(r.Context(), item.TaxIdentifierID, tc.Tenant.TenantID); err != nil {
		slog.Error("failed to enqueue tax identifier verification", "error", err)
	}

	WriteJSON(w, http.StatusCreated, taxIdentifierOutFromItem(*item))
}

// HandleReverifyTaxIdentifier mirrors POST /tax-identifiers/{id}/reverify.
func HandleReverifyTaxIdentifier(w http.ResponseWriter, r *http.Request, tc *TenantContext, taxIdentifierID string) {
	repo := repository.NewTaxIdentifiersRepo()
	item, err := repo.GetByID(r.Context(), tc.Tenant.TenantID, taxIdentifierID)
	if err != nil {
		WriteError(w, http.StatusNotFound, "Tax identifier not found")
		return
	}
	if _, err := repo.UpdateFields(r.Context(), tc.Tenant.TenantID, item.TaxIdentifierID, []repository.FieldUpdate{
		repository.F("verification_status", "PENDING"),
		repository.F("verification_error", nil),
	}); err != nil {
		slog.Error("reverify update failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not queue reverification")
		return
	}
	if _, err := queue.EnqueueTaxIdentifierVerification(r.Context(), item.TaxIdentifierID, tc.Tenant.TenantID); err != nil {
		slog.Error("failed to enqueue reverification", "error", err)
	}
	WriteJSON(w, http.StatusAccepted, map[string]string{"status": "PENDING"})
}

// HandleSetPrimaryTaxIdentifier mirrors POST /tax-identifiers/{id}/set-primary.
func HandleSetPrimaryTaxIdentifier(w http.ResponseWriter, r *http.Request, tc *TenantContext, taxIdentifierID string) {
	repo := repository.NewTaxIdentifiersRepo()
	item, err := repo.GetByID(r.Context(), tc.Tenant.TenantID, taxIdentifierID)
	if err != nil {
		WriteError(w, http.StatusNotFound, "Tax identifier not found")
		return
	}
	if err := repo.ClearPrimaryForType(r.Context(), tc.Tenant.TenantID, item.IDType, item.TaxIdentifierID); err != nil {
		slog.Error("clear primary failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not update primary tax identifier")
		return
	}
	updated, err := repo.UpdateFields(r.Context(), tc.Tenant.TenantID, item.TaxIdentifierID, []repository.FieldUpdate{
		repository.F("is_primary", true),
	})
	if err != nil {
		slog.Error("set primary failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not set primary tax identifier")
		return
	}
	WriteJSON(w, http.StatusOK, taxIdentifierOutFromItem(*updated))
}

// HandleDeleteTaxIdentifier mirrors DELETE /tax-identifiers/{id}.
func HandleDeleteTaxIdentifier(w http.ResponseWriter, r *http.Request, tc *TenantContext, taxIdentifierID string) {
	repo := repository.NewTaxIdentifiersRepo()
	if _, err := repo.GetByID(r.Context(), tc.Tenant.TenantID, taxIdentifierID); err != nil {
		WriteError(w, http.StatusNotFound, "Tax identifier not found")
		return
	}
	if err := repo.Delete(r.Context(), tc.Tenant.TenantID, taxIdentifierID); err != nil {
		slog.Error("delete tax identifier failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not delete tax identifier")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
