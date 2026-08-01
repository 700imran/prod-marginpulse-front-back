package httpapi

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/marginpulse/backend/internal/config"
	"github.com/marginpulse/backend/internal/queue"
	"github.com/marginpulse/backend/internal/repository"
	"github.com/marginpulse/backend/internal/storage"
)

type documentOut struct {
	DocumentID            string  `json:"document_id"`
	DocType               string  `json:"doc_type"`
	OriginalFilename      string  `json:"original_filename"`
	VendorName            string  `json:"vendor_name,omitempty"`
	DocumentDate          string  `json:"document_date,omitempty"`
	InvoiceNumber         string  `json:"invoice_number,omitempty"`
	RawTotalAmount        float64 `json:"raw_total_amount,omitempty"`
	TaxAmount             float64 `json:"tax_amount,omitempty"`
	TaxIdentifier         string  `json:"tax_identifier,omitempty"`
	ProcessingStatus      string  `json:"processing_status"`
	OCRConfidenceScore    float64 `json:"ocr_confidence_score,omitempty"`
	ReconciliationScore   float64 `json:"reconciliation_score,omitempty"`
	ReconciliationReason  string  `json:"reconciliation_reason,omitempty"`
	GSTPortalStatus       string  `json:"gst_portal_status,omitempty"`
	DuplicateOfDocumentID string  `json:"duplicate_of_document_id,omitempty"`
	ManuallyCorrected     bool    `json:"manually_corrected,omitempty"`
	CorrectedBy           string  `json:"corrected_by,omitempty"`
	CorrectedAt           string  `json:"corrected_at,omitempty"`
	CreatedAt             string  `json:"created_at"`
}

func documentOutFromItem(d repository.DocumentItem) documentOut {
	return documentOut{
		DocumentID: d.DocumentID, DocType: d.DocType, OriginalFilename: d.OriginalFilename,
		VendorName: d.VendorName, DocumentDate: d.DocumentDate, InvoiceNumber: d.InvoiceNumber,
		RawTotalAmount: d.RawTotalAmount, TaxAmount: d.TaxAmount, TaxIdentifier: d.TaxIdentifier,
		ProcessingStatus: d.ProcessingStatus, OCRConfidenceScore: d.OCRConfidenceScore,
		ReconciliationScore: d.ReconciliationScore, ReconciliationReason: d.ReconciliationReason,
		GSTPortalStatus: d.GSTPortalStatus, DuplicateOfDocumentID: d.DuplicateOfDocumentID,
		ManuallyCorrected: d.ManuallyCorrected, CorrectedBy: d.CorrectedBy, CorrectedAt: d.CorrectedAt,
		CreatedAt: d.CreatedAt,
	}
}

// HandleUploadDocument mirrors POST /documents (multipart file upload).
func HandleUploadDocument(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	cfg := config.Get()
	maxBytes := int64(cfg.MaxUploadSizeMB) << 20
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)

	if err := r.ParseMultipartForm(maxBytes); err != nil {
		WriteError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("File too large (max %dMB)", cfg.MaxUploadSizeMB))
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		WriteError(w, http.StatusBadRequest, "No file provided")
		return
	}
	defer file.Close()

	docType := r.FormValue("doc_type")
	if docType == "" {
		docType = "INVOICE"
	}

	data, err := io.ReadAll(file)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "Could not read uploaded file")
		return
	}

	contentType := header.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	s3Key := fmt.Sprintf("%s/%s/%s", tc.Tenant.TenantID, time.Now().UTC().Format("2006/01/02"), uuid.NewString()+extFromFilename(header.Filename))
	if _, err := storage.UploadBytes(r.Context(), data, s3Key, contentType); err != nil {
		slog.Error("document upload to storage failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not store file")
		return
	}

	docsRepo := repository.NewDocumentsRepo()
	doc, err := docsRepo.Create(r.Context(), repository.CreateDocumentInput{
		TenantID: tc.Tenant.TenantID, DocType: strings.ToUpper(docType),
		OriginalFilename: header.Filename, S3Key: s3Key, MimeType: contentType,
		FileSizeBytes: int64(len(data)), IngestChannel: "WEB",
	})
	if err != nil {
		slog.Error("document record creation failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not save document record")
		return
	}

	jobID, err := queue.EnqueueOCRPipeline(r.Context(), doc.DocumentID, s3Key, contentType, tc.Tenant.TenantID)
	if err != nil {
		slog.Error("failed to enqueue OCR pipeline", "error", err, "document_id", doc.DocumentID)
		// Document record already exists — the upload itself succeeded;
		// this is logged as an error for on-call visibility rather than
		// failing the whole request, since a lost background job
		// shouldn't erase a successful user-facing upload.
	}

	WriteJSON(w, http.StatusCreated, map[string]interface{}{
		"document_id":     doc.DocumentID,
		"tracking_job_id": jobID,
		"status":          doc.ProcessingStatus,
	})
}

func extFromFilename(name string) string {
	idx := strings.LastIndex(name, ".")
	if idx == -1 {
		return ""
	}
	return name[idx:]
}

// HandleListDocuments mirrors GET /documents.
func HandleListDocuments(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	q := r.URL.Query()
	status := q.Get("status")
	docType := q.Get("doc_type")
	skip, _ := strconv.Atoi(q.Get("skip"))
	limit := 50
	if l, err := strconv.Atoi(q.Get("limit")); err == nil && l > 0 {
		limit = l
	}

	docsRepo := repository.NewDocumentsRepo()
	items, total, err := docsRepo.ListByTenant(r.Context(), tc.Tenant.TenantID, status, docType, skip, limit)
	if err != nil {
		slog.Error("list documents failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not list documents")
		return
	}

	out := make([]documentOut, len(items))
	for i, d := range items {
		out[i] = documentOutFromItem(d)
	}
	WriteJSON(w, http.StatusOK, map[string]interface{}{
		"items": out, "total": total, "skip": skip, "limit": limit,
	})
}

// HandleGetDocument mirrors GET /documents/{id}.
func HandleGetDocument(w http.ResponseWriter, r *http.Request, tc *TenantContext, documentID string) {
	docsRepo := repository.NewDocumentsRepo()
	doc, err := docsRepo.GetByID(r.Context(), tc.Tenant.TenantID, documentID)
	if err != nil {
		WriteError(w, http.StatusNotFound, "Document not found")
		return
	}
	WriteJSON(w, http.StatusOK, documentOutFromItem(*doc))
}

// HandleGetDocumentDownloadURL mirrors the presigned-download-URL endpoint.
func HandleGetDocumentDownloadURL(w http.ResponseWriter, r *http.Request, tc *TenantContext, documentID string) {
	docsRepo := repository.NewDocumentsRepo()
	doc, err := docsRepo.GetByID(r.Context(), tc.Tenant.TenantID, documentID)
	if err != nil {
		WriteError(w, http.StatusNotFound, "Document not found")
		return
	}
	if doc.S3Key == "" {
		WriteError(w, http.StatusNotFound, "No file associated with this document")
		return
	}
	url, err := storage.GetPresignedURL(r.Context(), doc.S3Key, 15*time.Minute)
	if err != nil {
		slog.Error("presigned URL generation failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not generate download URL")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]string{"url": url})
}

// correctDocumentRequest lists the only fields HandleCorrectDocument
// accepts — deliberately excludes system-owned fields
// (processing_status, ocr_confidence_score, reconciliation_score,
// s3_key, etc.) so a manual correction can only ever touch the
// extracted business data, never the pipeline's own bookkeeping.
type correctDocumentRequest struct {
	VendorName     *string  `json:"vendor_name"`
	DocumentDate   *string  `json:"document_date"`
	InvoiceNumber  *string  `json:"invoice_number"`
	RawTotalAmount *float64 `json:"raw_total_amount"`
	TaxAmount      *float64 `json:"tax_amount"`
	TaxIdentifier  *string  `json:"tax_identifier"`
	// Reason is required — every manual correction needs a stated
	// reason so the audit trail actually explains *why* a human
	// overrode what OCR/reconciliation produced, not just what changed.
	Reason string `json:"reason"`
}

func fieldToString(v interface{}) string {
	switch val := v.(type) {
	case nil:
		return ""
	case string:
		return val
	case float64:
		return strconv.FormatFloat(val, 'f', -1, 64)
	default:
		return fmt.Sprintf("%v", val)
	}
}

// HandleCorrectDocument mirrors PATCH /documents/{id}/correct — the
// manual correction workflow. Any subset of the correctable fields may
// be sent; only fields actually present in the request body are
// changed. Every changed field writes its own AuditLogItem with the
// old value, new value, and the caller-supplied reason, so a reviewer
// can see exactly what a human overrode and why.
func HandleCorrectDocument(w http.ResponseWriter, r *http.Request, tc *TenantContext, documentID string) {
	var req correctDocumentRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Reason) == "" {
		WriteError(w, http.StatusUnprocessableEntity, "A reason is required for manual corrections")
		return
	}

	docsRepo := repository.NewDocumentsRepo()
	existing, err := docsRepo.GetByID(r.Context(), tc.Tenant.TenantID, documentID)
	if err != nil {
		WriteError(w, http.StatusNotFound, "Document not found")
		return
	}

	type change struct {
		field    string
		oldValue interface{}
		newValue interface{}
	}
	var changes []change
	if req.VendorName != nil && *req.VendorName != existing.VendorName {
		changes = append(changes, change{"vendor_name", existing.VendorName, *req.VendorName})
	}
	if req.DocumentDate != nil && *req.DocumentDate != existing.DocumentDate {
		changes = append(changes, change{"document_date", existing.DocumentDate, *req.DocumentDate})
	}
	if req.InvoiceNumber != nil && *req.InvoiceNumber != existing.InvoiceNumber {
		changes = append(changes, change{"invoice_number", existing.InvoiceNumber, *req.InvoiceNumber})
	}
	if req.RawTotalAmount != nil && *req.RawTotalAmount != existing.RawTotalAmount {
		changes = append(changes, change{"raw_total_amount", existing.RawTotalAmount, *req.RawTotalAmount})
	}
	if req.TaxAmount != nil && *req.TaxAmount != existing.TaxAmount {
		changes = append(changes, change{"tax_amount", existing.TaxAmount, *req.TaxAmount})
	}
	if req.TaxIdentifier != nil && *req.TaxIdentifier != existing.TaxIdentifier {
		changes = append(changes, change{"tax_identifier", existing.TaxIdentifier, *req.TaxIdentifier})
	}

	if len(changes) == 0 {
		WriteJSON(w, http.StatusOK, documentOutFromItem(*existing))
		return
	}

	updates := []repository.FieldUpdate{
		repository.F("manually_corrected", true),
		repository.F("corrected_by", tc.Tenant.OwnerEmail),
		repository.F("corrected_at", time.Now().UTC().Format(time.RFC3339)),
	}
	for _, c := range changes {
		updates = append(updates, repository.F(c.field, c.newValue))
	}

	updated, err := docsRepo.UpdateFields(r.Context(), tc.Tenant.TenantID, documentID, updates)
	if err != nil {
		slog.Error("manual correction failed", "document_id", documentID, "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not save correction")
		return
	}

	auditRepo := repository.NewAuditLogsRepo()
	for _, c := range changes {
		if _, err := auditRepo.Create(r.Context(), repository.CreateAuditLogInput{
			TenantID: tc.Tenant.TenantID, EntityType: "DOCUMENT", EntityID: documentID,
			Action: "MANUAL_CORRECTION", FieldName: c.field,
			OldValue: fieldToString(c.oldValue), NewValue: fieldToString(c.newValue),
			Reason: req.Reason, ActorEmail: tc.Tenant.OwnerEmail,
		}); err != nil {
			slog.Error("audit log write failed", "document_id", documentID, "field", c.field, "error", err)
		}
	}

	// A correction to any field reconciliation depends on
	// (vendor/amount/date) invalidates the previous match, so
	// re-queue reconciliation rather than leaving a stale score/status
	// in place.
	reconciliationRelevant := false
	for _, c := range changes {
		if c.field == "vendor_name" || c.field == "raw_total_amount" || c.field == "document_date" {
			reconciliationRelevant = true
			break
		}
	}
	if reconciliationRelevant {
		if _, err := queue.EnqueueReconciliation(r.Context(), documentID, tc.Tenant.TenantID); err != nil {
			slog.Error("failed to re-enqueue reconciliation after correction", "document_id", documentID, "error", err)
		}
	}

	WriteJSON(w, http.StatusOK, documentOutFromItem(*updated))
}

// HandleServeLocalFile mirrors the dev-mode-only local file server
// (STORAGE_BACKEND=local). Verifies the requesting tenant actually owns
// a document with this s3_key before serving bytes.
func HandleServeLocalFile(w http.ResponseWriter, r *http.Request, tc *TenantContext, key string) {
	docsRepo := repository.NewDocumentsRepo()
	doc, err := docsRepo.GetByS3Key(r.Context(), tc.Tenant.TenantID, key)
	if err != nil || doc == nil {
		WriteError(w, http.StatusNotFound, "File not found")
		return
	}
	data, err := storage.DownloadBytes(r.Context(), key)
	if err != nil {
		WriteError(w, http.StatusNotFound, "File not found")
		return
	}
	if doc.MimeType != "" {
		w.Header().Set("Content-Type", doc.MimeType)
	}
	w.Write(data)
}
