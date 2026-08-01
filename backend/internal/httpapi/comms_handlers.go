package httpapi

import (
	"net/http"

	"github.com/marginpulse/backend/internal/pipelines/insights"
	"github.com/marginpulse/backend/internal/repository"
)

// HandleGenerateReminder mirrors GET /comms/generate-reminder?document_id=&issue_type=
// — looks up the document to auto-fill vendor/invoice/amount/date rather
// than requiring the caller to pass them all, since the frontend only
// ever has a document_id in hand at the call site.
func HandleGenerateReminder(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	q := r.URL.Query()
	documentID := q.Get("document_id")
	issueType := q.Get("issue_type")
	if issueType == "" {
		issueType = "GST_PORTAL_MISMATCH"
	}
	if documentID == "" {
		WriteError(w, http.StatusBadRequest, "document_id is required")
		return
	}

	docsRepo := repository.NewDocumentsRepo()
	doc, err := docsRepo.GetByID(r.Context(), tc.Tenant.TenantID, documentID)
	if err != nil {
		WriteError(w, http.StatusNotFound, "Document not found")
		return
	}

	vendorName := doc.VendorName
	if vendorName == "" {
		vendorName = "Vendor"
	}
	script := insights.GenerateCollectionScript(vendorName, doc.InvoiceNumber, doc.RawTotalAmount, doc.DocumentDate, issueType)
	WriteJSON(w, http.StatusOK, map[string]string{"script": script})
}
