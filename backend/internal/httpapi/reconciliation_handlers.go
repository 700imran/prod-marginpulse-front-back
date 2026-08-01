package httpapi

import (
	"bufio"
	"encoding/csv"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/marginpulse/backend/internal/pipelines/exceptions"
	"github.com/marginpulse/backend/internal/pipelines/insights"
	"github.com/marginpulse/backend/internal/queue"
	"github.com/marginpulse/backend/internal/repository"
)

type dashboardSummaryMetrics struct {
	TotalUploadedDocuments        int `json:"total_uploaded_documents"`
	SuccessfullyReconciledCount   int `json:"successfully_reconciled_count"`
	UnreconciledAnomaliesDetected int `json:"unreconciled_anomalies_detected"`
	GSTMismatchFlagCount          int `json:"gst_mismatch_flag_count"`
}

type dashboardSummaryOut struct {
	SummaryMetrics      dashboardSummaryMetrics `json:"summary_metrics"`
	ITCAtRisk           float64                 `json:"itc_at_risk"`
	GSTProblemVendors   []string                `json:"gst_problem_vendors"`
	PlainEnglishInsight string                  `json:"plain_english_insight"`
}

// HandleDashboardSummary mirrors GET /reconciliation/dashboard-summary.
// Counts use GSI1 (RECONCILED status) for an efficient count, and GSI2
// (sparse GST-status index) for the mismatch/not-filed list — see
// documents.go repository comments for why these specific queries are
// cheap even as a tenant's document volume grows.
func HandleDashboardSummary(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	tenantID := tc.Tenant.TenantID
	docsRepo := repository.NewDocumentsRepo()
	anomaliesRepo := repository.NewAnomaliesRepo()

	total, err := docsRepo.CountTotal(r.Context(), tenantID)
	if err != nil {
		slog.Error("dashboard summary: count total failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not load dashboard")
		return
	}
	reconciled, err := docsRepo.CountByStatus(r.Context(), tenantID, "RECONCILED")
	if err != nil {
		slog.Error("dashboard summary: count reconciled failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not load dashboard")
		return
	}

	// Open anomalies — capped list (mirrors the Python version's
	// identical `limit(20)` behavior, including using this same capped
	// list's length as the displayed count rather than a true total).
	openAnomalies, err := anomaliesRepo.ListByTenant(r.Context(), tenantID, repository.ListAnomaliesOptions{Status: "OPEN", Limit: 20})
	if err != nil {
		slog.Error("dashboard summary: list anomalies failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not load dashboard")
		return
	}
	gstMismatchCount := 0
	for _, a := range openAnomalies {
		if a.AnomalyType == "TAX_PORTAL_MISMATCH" {
			gstMismatchCount++
		}
	}

	notFiledDocs, err := docsRepo.ListByGSTStatus(r.Context(), tenantID, "NOT_FILED")
	if err != nil {
		slog.Error("dashboard summary: list NOT_FILED failed", "error", err)
		notFiledDocs = nil
	}
	mismatchDocs, err := docsRepo.ListByGSTStatus(r.Context(), tenantID, "MISMATCH")
	if err != nil {
		slog.Error("dashboard summary: list MISMATCH failed", "error", err)
		mismatchDocs = nil
	}

	itcAtRisk := 0.0
	vendorSet := map[string]bool{}
	var problemVendors []string
	for _, d := range append(notFiledDocs, mismatchDocs...) {
		itcAtRisk += d.TaxAmount
		if d.VendorName != "" && !vendorSet[d.VendorName] {
			vendorSet[d.VendorName] = true
			if len(problemVendors) < 5 {
				problemVendors = append(problemVendors, d.VendorName)
			}
		}
	}

	summary := insights.SummaryData{
		TotalUploadedDocuments:        total,
		SuccessfullyReconciledCount:   reconciled,
		UnreconciledAnomaliesDetected: len(openAnomalies),
		GSTMismatchFlagCount:          gstMismatchCount,
		ITCAtRisk:                     itcAtRisk,
		GSTProblemVendors:             problemVendors,
	}
	plainEnglish := insights.GenerateInsight(r.Context(), summary, tenantID)

	WriteJSON(w, http.StatusOK, dashboardSummaryOut{
		SummaryMetrics: dashboardSummaryMetrics{
			TotalUploadedDocuments: total, SuccessfullyReconciledCount: reconciled,
			UnreconciledAnomaliesDetected: len(openAnomalies), GSTMismatchFlagCount: gstMismatchCount,
		},
		ITCAtRisk: itcAtRisk, GSTProblemVendors: problemVendors, PlainEnglishInsight: plainEnglish,
	})
}

// HandleRunReconciliation mirrors POST /reconciliation/run — re-queues
// every PARSED document for another reconciliation pass.
func HandleRunReconciliation(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	docsRepo := repository.NewDocumentsRepo()
	docs, err := docsRepo.ListByStatus(r.Context(), tc.Tenant.TenantID, "PARSED")
	if err != nil {
		slog.Error("run reconciliation: list PARSED failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not start reconciliation")
		return
	}

	queued := 0
	for _, doc := range docs {
		if _, err := queue.EnqueueReconciliation(r.Context(), doc.DocumentID, tc.Tenant.TenantID); err != nil {
			slog.Error("failed to enqueue reconciliation", "document_id", doc.DocumentID, "error", err)
			continue
		}
		queued++
	}
	WriteJSON(w, http.StatusOK, map[string]interface{}{"job_id": uuid.NewString(), "documents_queued": queued})
}

type anomalyOut struct {
	AnomalyID       string `json:"anomaly_id"`
	DocumentID      string `json:"document_id,omitempty"`
	Type            string `json:"type"`
	Severity        string `json:"severity"`
	Description     string `json:"description"`
	SuggestedAction string `json:"suggested_action,omitempty"`
	Status          string `json:"status"`
	CreatedAt       string `json:"created_at"`
}

// HandleListAnomalies mirrors GET /reconciliation/anomalies.
func HandleListAnomalies(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	q := r.URL.Query()
	anomaliesRepo := repository.NewAnomaliesRepo()
	items, err := anomaliesRepo.ListByTenant(r.Context(), tc.Tenant.TenantID, repository.ListAnomaliesOptions{
		Status: q.Get("status"), Severity: q.Get("severity"),
	})
	if err != nil {
		slog.Error("list anomalies failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not list anomalies")
		return
	}
	out := make([]anomalyOut, len(items))
	for i, a := range items {
		out[i] = anomalyOut{
			AnomalyID: a.AnomalyID, DocumentID: a.DocumentID, Type: a.AnomalyType,
			Severity: a.Severity, Description: a.Description, SuggestedAction: a.SuggestedAction,
			Status: a.Status, CreatedAt: a.CreatedAt,
		}
	}
	WriteJSON(w, http.StatusOK, map[string]interface{}{"items": out})
}

// HandleResolveAnomaly mirrors POST /reconciliation/anomaly/{id}/resolve.
func HandleResolveAnomaly(w http.ResponseWriter, r *http.Request, tc *TenantContext, anomalyID string) {
	anomaliesRepo := repository.NewAnomaliesRepo()
	existing, err := anomaliesRepo.GetByID(r.Context(), tc.Tenant.TenantID, anomalyID)
	if err != nil {
		WriteError(w, http.StatusNotFound, "Anomaly not found")
		return
	}
	resolved, err := anomaliesRepo.Resolve(r.Context(), tc.Tenant.TenantID, anomalyID, existing.CreatedAt, tc.Tenant.OwnerEmail)
	if err != nil {
		slog.Error("resolve anomaly failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not resolve anomaly")
		return
	}

	auditRepo := repository.NewAuditLogsRepo()
	if _, err := auditRepo.Create(r.Context(), repository.CreateAuditLogInput{
		TenantID: tc.Tenant.TenantID, EntityType: "ANOMALY", EntityID: anomalyID,
		Action: "ANOMALY_RESOLVED", ActorEmail: tc.Tenant.OwnerEmail,
	}); err != nil {
		slog.Error("audit log write failed for anomaly resolve", "anomaly_id", anomalyID, "error", err)
	}

	WriteJSON(w, http.StatusOK, anomalyOut{
		AnomalyID: resolved.AnomalyID, DocumentID: resolved.DocumentID, Type: resolved.AnomalyType,
		Severity: resolved.Severity, Description: resolved.Description, Status: resolved.Status,
		CreatedAt: resolved.CreatedAt,
	})
}

// HandleExportReconciliationReport mirrors GET /reconciliation/export —
// the "downloadable reconciliation report" V1 requirement. Streams a
// CSV of every document for this tenant, one row each, including the
// reconciliation evidence/exception reason so the report is useful for
// a CA to review offline, not just a raw data dump.
func HandleExportReconciliationReport(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	docsRepo := repository.NewDocumentsRepo()
	docs, err := docsRepo.ListAllForExport(r.Context(), tc.Tenant.TenantID)
	if err != nil {
		slog.Error("reconciliation export: list documents failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not generate export")
		return
	}

	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"reconciliation-report-%s.csv\"", time.Now().UTC().Format("2006-01-02")))

	writer := csv.NewWriter(w)
	defer writer.Flush()

	_ = writer.Write([]string{
		"document_id", "vendor_name", "invoice_number", "document_date", "raw_total_amount",
		"tax_amount", "tax_identifier", "processing_status", "ocr_confidence_score",
		"reconciliation_score", "matched_bank_transaction_id", "gst_portal_status",
		"exception_reason", "duplicate_of_document_id", "manually_corrected", "created_at",
	})
	for _, d := range docs {
		_ = writer.Write([]string{
			d.DocumentID, d.VendorName, d.InvoiceNumber, d.DocumentDate,
			strconv.FormatFloat(d.RawTotalAmount, 'f', 2, 64),
			strconv.FormatFloat(d.TaxAmount, 'f', 2, 64),
			d.TaxIdentifier, d.ProcessingStatus,
			strconv.FormatFloat(d.OCRConfidenceScore, 'f', 2, 64),
			strconv.FormatFloat(d.ReconciliationScore, 'f', 2, 64),
			d.MatchedBankTransactionID, d.GSTPortalStatus, d.ReconciliationReason,
			d.DuplicateOfDocumentID, strconv.FormatBool(d.ManuallyCorrected), d.CreatedAt,
		})
	}
}

// HandleDetectMissingInvoices mirrors
// POST /reconciliation/detect-missing-invoices — an on-demand trigger
// for the missing-invoice heuristic (see internal/pipelines/exceptions).
// Exposed as a POST endpoint rather than a background schedule since
// this baseline has no cron/EventBridge wiring yet; see the handover
// notes for adding a scheduled trigger later.
func HandleDetectMissingInvoices(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	result, err := exceptions.DetectMissingInvoices(r.Context(), tc.Tenant.TenantID)
	if err != nil {
		slog.Error("detect missing invoices failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not run missing-invoice detection")
		return
	}
	WriteJSON(w, http.StatusOK, map[string]interface{}{
		"bank_transactions_scanned": result.BankTransactionsScanned,
		"anomalies_created":         result.AnomaliesCreated,
	})
}

// HandleBankCSVUpload mirrors POST /reconciliation/bank-csv-upload —
// parses an uploaded bank statement CSV and creates one BankTransaction
// per row. Tolerant of common Indian bank export header name variations
// (case-insensitive, several synonyms per column) since different banks
// (HDFC, ICICI, SBI, Axis, Kotak) each export slightly different column
// names for the same data.
func HandleBankCSVUpload(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	bankName := r.URL.Query().Get("bank_name")

	if err := r.ParseMultipartForm(10 << 20); err != nil {
		WriteError(w, http.StatusBadRequest, "Could not parse upload — file too large or malformed")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		WriteError(w, http.StatusBadRequest, "No CSV file provided")
		return
	}
	defer file.Close()

	rows, err := parseBankCSV(file)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "Could not parse CSV: "+err.Error())
		return
	}
	if len(rows) == 0 {
		WriteError(w, http.StatusBadRequest, "CSV file contains no valid transaction rows")
		return
	}

	txnRepo := repository.NewBankTransactionsRepo()
	created := 0
	for _, row := range rows {
		if _, err := txnRepo.Create(r.Context(), repository.CreateBankTransactionInput{
			TenantID: tc.Tenant.TenantID, Narration: row.Narration, TransactionDate: row.Date.Format("2006-01-02"),
			DebitAmount: row.Debit, CreditAmount: row.Credit, BankName: bankName,
			SourceFilename: header.Filename,
		}); err != nil {
			slog.Error("bank transaction creation failed", "error", err)
			continue
		}
		created++
	}

	WriteJSON(w, http.StatusOK, map[string]interface{}{
		"transactions_created": created, "rows_in_file": len(rows), "bank_name": bankName,
	})
}

type bankCSVRow struct {
	Date      time.Time
	Narration string
	Debit     float64
	Credit    float64
}

// dateColumnLayouts covers the date formats commonly seen across Indian
// bank statement exports (DD/MM/YYYY is by far the most common, but
// ISO and DD-MM-YYYY also appear).
var dateColumnLayouts = []string{"02/01/2006", "2006-01-02", "02-01-2006", "2-1-2006"}

func parseCSVDate(s string) (time.Time, error) {
	s = strings.TrimSpace(s)
	var lastErr error
	for _, layout := range dateColumnLayouts {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		} else {
			lastErr = err
		}
	}
	return time.Time{}, lastErr
}

func parseAmount(s string) float64 {
	s = strings.TrimSpace(s)
	s = strings.ReplaceAll(s, ",", "")
	s = strings.TrimPrefix(s, "₹")
	s = strings.TrimSpace(s)
	if s == "" || s == "-" {
		return 0
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return v
}

// parseBankCSV reads a comma-separated bank statement, matching header
// names case-insensitively against several known synonyms per column.
// Deliberately hand-rolled (not encoding/csv's Reader used raw, though
// it's underneath this) rather than requiring an exact header — a
// production bank-reconciliation feature needs to tolerate whatever
// column names each bank happens to export.
func parseBankCSV(r io.Reader) ([]bankCSVRow, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 1024*1024), 10*1024*1024)

	var headerCols []string
	var rows []bankCSVRow
	lineNum := 0

	dateIdx, narrationIdx, debitIdx, creditIdx := -1, -1, -1, -1

	for scanner.Scan() {
		line := scanner.Text()
		lineNum++
		cols := splitCSVLine(line)

		if lineNum == 1 {
			headerCols = cols
			for i, col := range headerCols {
				c := strings.ToLower(strings.TrimSpace(col))
				switch {
				case dateIdx == -1 && (c == "date" || c == "txn date" || c == "transaction date" || c == "value date"):
					dateIdx = i
				case narrationIdx == -1 && (c == "narration" || c == "description" || c == "particulars" || c == "remarks"):
					narrationIdx = i
				case debitIdx == -1 && (c == "debit" || c == "withdrawal" || c == "debit amount" || c == "withdrawal amt"):
					debitIdx = i
				case creditIdx == -1 && (c == "credit" || c == "deposit" || c == "credit amount" || c == "deposit amt"):
					creditIdx = i
				}
			}
			continue
		}

		if dateIdx == -1 || narrationIdx == -1 {
			continue // header never resolved a date/narration column — skip data rows
		}
		if dateIdx >= len(cols) || narrationIdx >= len(cols) {
			continue
		}

		date, err := parseCSVDate(cols[dateIdx])
		if err != nil {
			continue // unparseable row — skip rather than fail the whole upload
		}

		row := bankCSVRow{Date: date, Narration: strings.TrimSpace(cols[narrationIdx])}
		if debitIdx != -1 && debitIdx < len(cols) {
			row.Debit = parseAmount(cols[debitIdx])
		}
		if creditIdx != -1 && creditIdx < len(cols) {
			row.Credit = parseAmount(cols[creditIdx])
		}
		if row.Debit == 0 && row.Credit == 0 {
			continue // no monetary movement — likely a blank/summary row
		}
		rows = append(rows, row)
	}

	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return rows, nil
}

// splitCSVLine is a minimal comma splitter that respects double-quoted
// fields (so a narration containing a comma, e.g. "SALARY, JUNE 2026",
// isn't split incorrectly) — kept intentionally small rather than
// pulling in encoding/csv's Reader, since bank statement exports rarely
// use escaped quotes or multi-line fields.
func splitCSVLine(line string) []string {
	var fields []string
	var current strings.Builder
	inQuotes := false
	for _, r := range line {
		switch {
		case r == '"':
			inQuotes = !inQuotes
		case r == ',' && !inQuotes:
			fields = append(fields, current.String())
			current.Reset()
		default:
			current.WriteRune(r)
		}
	}
	fields = append(fields, current.String())
	return fields
}
