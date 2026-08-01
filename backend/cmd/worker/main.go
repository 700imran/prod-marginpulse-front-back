// cmd/worker — AWS Lambda entry point for SQS-triggered background
// tasks, replacing 03-lambda-workers/lambda_handler.py. All five task
// families share this one binary/dispatcher (infra assigns each SQS
// queue's Lambda function the same image, differing only by which queue
// triggers it) — mirrors the Python version's single lambda_handler.py
// module with one shared dispatcher underneath five thin per-queue entry
// points.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"

	"github.com/marginpulse/backend/internal/logging"
	"github.com/marginpulse/backend/internal/pipelines/gstsync"
	"github.com/marginpulse/backend/internal/pipelines/identity"
	"github.com/marginpulse/backend/internal/pipelines/ocr"
	"github.com/marginpulse/backend/internal/pipelines/reconciliation"
	"github.com/marginpulse/backend/internal/repository"
	"github.com/marginpulse/backend/internal/security"
	"github.com/marginpulse/backend/internal/storage"
)

func init() {
	logging.Configure()
}

type taskMessage struct {
	Task  string                 `json:"task"`
	JobID string                 `json:"job_id"`
	Args  map[string]interface{} `json:"args"`
}

func argStr(args map[string]interface{}, key string) string {
	if v, ok := args[key].(string); ok {
		return v
	}
	return ""
}

func timeNowISO() string {
	return time.Now().UTC().Format(time.RFC3339)
}

// ── Task bodies (identical business logic to the old Python worker's
// task bodies — see queue_service.py for the message contract each one
// consumes) ──────────────────────────────────────────────────────────

func runOCRPipeline(ctx context.Context, args map[string]interface{}) error {
	documentID := argStr(args, "document_id")
	s3Key := argStr(args, "s3_key")
	mimeType := argStr(args, "mime_type")
	tenantID := argStr(args, "tenant_id")

	data, err := storage.DownloadBytes(ctx, s3Key)
	if err != nil {
		return err
	}

	result, err := ocr.ProcessDocument(ctx, data, mimeType)
	if err != nil {
		return err
	}

	docsRepo := repository.NewDocumentsRepo()
	updates := []repository.FieldUpdate{
		repository.F("processing_status", "PARSED"),
	}
	if result.VendorName != "" {
		updates = append(updates, repository.F("vendor_name", result.VendorName))
	}
	if result.DocumentDate != "" {
		updates = append(updates, repository.F("document_date", result.DocumentDate))
	}
	if result.RawTotalAmount != 0 {
		updates = append(updates, repository.F("raw_total_amount", result.RawTotalAmount))
	}
	if result.TaxAmount != 0 {
		updates = append(updates, repository.F("tax_amount", result.TaxAmount))
	}
	if result.TaxIdentifier != "" {
		updates = append(updates, repository.F("tax_identifier", result.TaxIdentifier))
	}
	if result.InvoiceNumber != "" {
		updates = append(updates, repository.F("invoice_number", result.InvoiceNumber))
	}
	updates = append(updates, repository.F("ocr_confidence_score", result.Confidence))

	if _, err := docsRepo.UpdateFields(ctx, tenantID, documentID, updates); err != nil {
		return err
	}
	slog.Info("ocr_pipeline_completed", "document_id", documentID)

	checkForDuplicateInvoice(ctx, docsRepo, tenantID, documentID, result.VendorName, result.InvoiceNumber, result.RawTotalAmount, result.DocumentDate)

	// Chain directly into reconciliation within the same invocation
	// rather than a second SQS round trip — see the Python worker's
	// identical rationale for this (cheaper, lower latency, and OCR
	// re-running on a retry is idempotent since it re-reads from S3).
	return runReconciliation(ctx, map[string]interface{}{"document_id": documentID, "tenant_id": tenantID})
}

// checkForDuplicateInvoice runs right after OCR extracts a document's
// vendor/invoice-number/amount/date. Errors are logged, not returned —
// a failed duplicate check should never fail the OCR pipeline itself.
func checkForDuplicateInvoice(ctx context.Context, docsRepo *repository.DocumentsRepo, tenantID, documentID, vendorName, invoiceNumber string, amount float64, documentDate string) {
	dup, err := docsRepo.FindDuplicate(ctx, tenantID, vendorName, invoiceNumber, amount, documentDate, documentID)
	if err != nil {
		slog.Error("duplicate_invoice_check_failed", "document_id", documentID, "error", err)
		return
	}
	if dup == nil {
		return
	}

	if _, err := docsRepo.UpdateFields(ctx, tenantID, documentID, []repository.FieldUpdate{
		repository.F("duplicate_of_document_id", dup.DocumentID),
	}); err != nil {
		slog.Error("duplicate_invoice_flag_update_failed", "document_id", documentID, "error", err)
	}

	anomaliesRepo := repository.NewAnomaliesRepo()
	description := fmt.Sprintf("Looks like a duplicate of document %s — same vendor (%s) and matching invoice number or amount+date", dup.DocumentID, vendorName)
	if _, err := anomaliesRepo.Create(ctx, repository.CreateAnomalyInput{
		TenantID: tenantID, DocumentID: documentID, AnomalyType: "DUPLICATE_INVOICE",
		Severity: "HIGH", Description: description,
		SuggestedAction: "Confirm this isn't a re-upload or a genuine duplicate vendor bill before including it in ITC claims",
	}); err != nil {
		slog.Error("duplicate_invoice_anomaly_create_failed", "document_id", documentID, "error", err)
		return
	}

	auditRepo := repository.NewAuditLogsRepo()
	if _, err := auditRepo.Create(ctx, repository.CreateAuditLogInput{
		TenantID: tenantID, EntityType: "DOCUMENT", EntityID: documentID,
		Action: "DUPLICATE_DETECTED", Reason: description,
	}); err != nil {
		slog.Error("duplicate_invoice_audit_log_failed", "document_id", documentID, "error", err)
	}
	slog.Info("duplicate_invoice_detected", "document_id", documentID, "duplicate_of", dup.DocumentID)
}

func runReconciliation(ctx context.Context, args map[string]interface{}) error {
	documentID := argStr(args, "document_id")
	tenantID := argStr(args, "tenant_id")

	docsRepo := repository.NewDocumentsRepo()
	doc, err := docsRepo.GetByID(ctx, tenantID, documentID)
	if err != nil {
		return err
	}
	if doc.RawTotalAmount == 0 || doc.DocumentDate == "" {
		slog.Info("reconciliation_skipped_no_amount_or_date", "document_id", documentID)
		return nil
	}

	docDate, err := time.Parse("2006-01-02", doc.DocumentDate)
	if err != nil {
		return err
	}
	startDate := docDate.AddDate(0, 0, -10).Format("2006-01-02")
	endDate := docDate.AddDate(0, 0, 10).Format("2006-01-02")

	txnRepo := repository.NewBankTransactionsRepo()
	candidates, err := txnRepo.ListUnmatchedInDateRange(ctx, tenantID, startDate, endDate)
	if err != nil {
		return err
	}

	invoice := reconciliation.Invoice{
		DocumentID: doc.DocumentID, VendorName: doc.VendorName,
		RawTotalAmount: doc.RawTotalAmount, DocumentDate: doc.DocumentDate,
	}
	bankRows := make([]reconciliation.BankRow, len(candidates))
	for i, c := range candidates {
		bankRows[i] = reconciliation.BankRow{
			TransactionID: c.TransactionID, Narration: c.Narration,
			DebitAmount: c.DebitAmount, TransactionDate: c.TransactionDate,
		}
	}

	results := reconciliation.ReconcileBatch([]reconciliation.Invoice{invoice}, bankRows)
	if len(results) == 0 {
		return nil
	}
	result := results[0]

	docStatus := "PARSED"
	if result.Status == "RECONCILED" {
		docStatus = "RECONCILED"
	}
	updates := []repository.FieldUpdate{
		repository.F("reconciliation_score", result.Score),
		repository.F("processing_status", docStatus),
	}
	if result.MatchedBankTransactionID != "" {
		updates = append(updates, repository.F("matched_bank_transaction_id", result.MatchedBankTransactionID))
	}
	if result.Reason != "" {
		updates = append(updates, repository.F("reconciliation_reason", result.Reason))
	}
	if _, err := docsRepo.UpdateFields(ctx, tenantID, documentID, updates); err != nil {
		return err
	}

	// RECONCILED needs no human attention. MANUAL_REVIEW and UNMATCHED
	// both get a reconciliation-exception anomaly so they surface on
	// the dashboard's anomaly list with the specific reason attached —
	// this is the "exception reason for every mismatch" requirement.
	if result.Status == "MANUAL_REVIEW" || result.Status == "UNMATCHED" {
		anomaliesRepo := repository.NewAnomaliesRepo()
		severity := "MEDIUM"
		if result.Status == "UNMATCHED" {
			severity = "LOW"
		}
		if _, err := anomaliesRepo.Create(ctx, repository.CreateAnomalyInput{
			TenantID: tenantID, DocumentID: documentID, AnomalyType: "RECONCILIATION_" + result.Status,
			Severity: severity, Description: result.Reason,
			SuggestedAction: "Review the candidate match and either confirm it manually or upload the missing bank statement",
		}); err != nil {
			slog.Error("reconciliation_anomaly_create_failed", "document_id", documentID, "error", err)
		}
	}

	if result.MatchedBankTransactionID != "" {
		for _, c := range candidates {
			if c.TransactionID == result.MatchedBankTransactionID {
				if _, err := txnRepo.UpdateFields(ctx, tenantID, c.TransactionID, c.TransactionDate, []repository.FieldUpdate{
					repository.F("reconciliation_status", "MATCHED"),
					repository.F("matched_document_id", documentID),
					repository.F("match_score", result.Score),
				}); err != nil {
					return err
				}
				break
			}
		}
	}

	slog.Info("reconciliation_completed", "document_id", documentID, "status", result.Status, "score", result.Score)
	return nil
}

func syncGSTPortal(ctx context.Context, args map[string]interface{}) error {
	tenantID := argStr(args, "tenant_id")
	gstin := argStr(args, "gstin")
	period := argStr(args, "period")

	client := gstsync.NewPortalClient()
	gstr2bJSON, err := client.FetchGSTR2B(ctx, gstin, period)
	if err != nil {
		return err
	}
	portalSuppliers := gstsync.ParseGSTR2BSuppliers(gstr2bJSON)

	docsRepo := repository.NewDocumentsRepo()
	invoices, err := docsRepo.ListInvoicesWithTaxIdentifier(ctx, tenantID)
	if err != nil {
		return err
	}

	internalVendors := make([]gstsync.InternalVendor, len(invoices))
	for i, inv := range invoices {
		internalVendors[i] = gstsync.InternalVendor{
			DocumentID: inv.DocumentID, VendorName: inv.VendorName,
			TaxIdentifier: inv.TaxIdentifier, RawTotalAmount: inv.RawTotalAmount,
			InvoiceNumber: inv.InvoiceNumber,
		}
	}

	results := gstsync.CrossVerifyVendors(internalVendors, portalSuppliers)
	for _, r := range results {
		if _, err := docsRepo.UpdateFields(ctx, tenantID, r.DocumentID, []repository.FieldUpdate{
			repository.F("gst_portal_status", r.GSTPortalStatus),
		}); err != nil {
			slog.Error("gst_sync_document_update_failed", "document_id", r.DocumentID, "error", err)
		}
	}

	slog.Info("gst_sync_completed", "tenant_id", tenantID, "vendors_checked", len(internalVendors))
	return nil
}

func verifyTaxIdentifier(ctx context.Context, args map[string]interface{}) error {
	taxIdentifierID := argStr(args, "tax_identifier_id")
	tenantID := argStr(args, "tenant_id")

	repo := repository.NewTaxIdentifiersRepo()
	taxID, err := repo.GetByID(ctx, tenantID, taxIdentifierID)
	if err != nil {
		return err
	}

	var result identity.Result
	switch taxID.IDType {
	case "GSTIN":
		result = identity.VerifyGSTIN(ctx, taxID.IDValue)
	case "PAN":
		result = identity.VerifyPAN(ctx, taxID.IDValue, taxID.Label)
	default:
		result = identity.Result{Status: "PENDING", Error: "No automated verifier for this type yet — verify manually"}
	}

	updates := []repository.FieldUpdate{repository.F("verification_status", result.Status)}
	if result.Error != "" {
		updates = append(updates, repository.F("verification_error", result.Error))
	}
	if result.LegalName != "" {
		updates = append(updates, repository.F("verified_legal_name", result.LegalName))
	}
	if result.Status == "VERIFIED" {
		updates = append(updates, repository.F("verified_at", timeNowISO()))
	}
	if _, err := repo.UpdateFields(ctx, tenantID, taxIdentifierID, updates); err != nil {
		return err
	}

	slog.Info("tax_identifier_verification_completed", "tax_identifier_id", taxIdentifierID, "status", result.Status)
	return nil
}

func verifyBankAccountTask(ctx context.Context, args map[string]interface{}) error {
	bankAccountID := argStr(args, "bank_account_id")
	tenantID := argStr(args, "tenant_id")

	repo := repository.NewBankAccountsRepo()
	account, err := repo.GetByID(ctx, tenantID, bankAccountID)
	if err != nil {
		return err
	}

	plaintext, err := security.DecryptField(account.AccountNumberEncrypted)
	if err != nil {
		return err
	}
	result := identity.VerifyBankAccount(ctx, plaintext, account.IFSCCode, account.AccountHolderName)
	// plaintext goes out of scope here and is never stored/logged.

	updates := []repository.FieldUpdate{repository.F("verification_status", result.Status)}
	if result.Error != "" {
		updates = append(updates, repository.F("verification_error", result.Error))
	}
	if result.VerifiedName != "" {
		updates = append(updates, repository.F("verified_account_holder_name", result.VerifiedName))
	}
	if result.Status == "VERIFIED" {
		updates = append(updates, repository.F("verified_at", timeNowISO()))
	}
	if _, err := repo.UpdateFields(ctx, tenantID, bankAccountID, updates); err != nil {
		return err
	}

	slog.Info("bank_account_verification_completed", "bank_account_id", bankAccountID, "status", result.Status)
	return nil
}

var taskRegistry = map[string]func(context.Context, map[string]interface{}) error{
	"run_ocr_pipeline":         runOCRPipeline,
	"run_reconciliation":       runReconciliation,
	"sync_gst_portal":          syncGSTPortal,
	"verify_tax_identifier":    verifyTaxIdentifier,
	"verify_bank_account_task": verifyBankAccountTask,
}

// dispatch is the shared SQS batch handler — every queue's Lambda
// function points here. Uses partial batch response
// (ReportBatchItemFailures) so one bad message in a batch doesn't force
// a retry of the whole batch.
func dispatch(ctx context.Context, sqsEvent events.SQSEvent) (events.SQSEventResponse, error) {
	var failures []events.SQSBatchItemFailure

	for _, record := range sqsEvent.Records {
		var msg taskMessage
		if err := json.Unmarshal([]byte(record.Body), &msg); err != nil {
			slog.Error("malformed_task_message", "message_id", record.MessageId, "error", err)
			continue // unknown/malformed — don't retry forever, drop it
		}

		taskFn, ok := taskRegistry[msg.Task]
		if !ok {
			slog.Error("unknown_task", "task", msg.Task, "message_id", record.MessageId)
			continue
		}

		slog.Info("task_started", "task", msg.Task, "job_id", msg.JobID)
		if err := taskFn(ctx, msg.Args); err != nil {
			slog.Error("task_failed", "task", msg.Task, "job_id", msg.JobID, "error", err)
			failures = append(failures, events.SQSBatchItemFailure{ItemIdentifier: record.MessageId})
			continue
		}
		slog.Info("task_completed", "task", msg.Task, "job_id", msg.JobID)
	}

	return events.SQSEventResponse{BatchItemFailures: failures}, nil
}

func main() {
	lambda.Start(dispatch)
}
