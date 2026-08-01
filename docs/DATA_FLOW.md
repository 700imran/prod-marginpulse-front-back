# Data Flow

## 1. Document upload → OCR → reconciliation (the core pipeline)

```
1. Browser: POST /api/v1/documents/upload (multipart file + doc_type)
2. API Lambda:
   - stores file in S3 (or local filesystem in dev) via internal/storage
   - writes a DocumentItem (processing_status=INGESTED)
   - enqueues run_ocr_pipeline to SQS (queue/queue.go EnqueueOCRPipeline)
   - returns tracking_job_id to the browser immediately (no waiting)
3. Worker Lambda (SQS trigger) — cmd/worker/main.go runOCRPipeline:
   - downloads the file bytes from storage
   - calls internal/pipelines/ocr.ProcessDocument(bytes, mimeType)
     → invokes ocr-service Lambda (RapidOCR, +PyMuPDF for PDFs)
     → regex-extracts vendor/amount/tax/date/GSTIN/invoice number
   - updates the DocumentItem with extracted fields + ocr_confidence_score
   - checkForDuplicateInvoice(): scans for a matching existing document
     (same vendor+invoice#, or same vendor+amount+date) → if found,
     sets duplicate_of_document_id + raises a DUPLICATE_INVOICE anomaly
     + writes an audit log entry
   - enqueues run_reconciliation for the same document
4. Worker Lambda — runReconciliation:
   - calls internal/pipelines/reconciliation.ReconcileBatch()
     → scores every candidate bank transaction (vendor/narration
       similarity + amount + date proximity)
     → classifies RECONCILED / MANUAL_REVIEW / UNMATCHED with a
       human-readable Reason string for every outcome
   - updates the document: processing_status, reconciliation_score,
     reconciliation_reason, matched_bank_transaction_id
   - if MANUAL_REVIEW or UNMATCHED: raises a
     RECONCILIATION_MANUAL_REVIEW / RECONCILIATION_UNMATCHED anomaly
     with that Reason as the description
```

## 2. Bank statement upload

```
1. Browser: POST /api/v1/reconciliation/bank-csv-upload (multipart CSV)
2. API Lambda: parses CSV rows into BankTransactionItems
   (gsi2pk=TENANT#<id>#UNMATCHED while unmatched — removed once matched)
3. Reconciliation (step 4 above) picks these up as match candidates
   for any INVOICE-type document not yet RECONCILED.
```

## 3. Manual correction

```
1. Browser: PATCH /api/v1/documents/{id}/correct
   { vendor_name?, document_date?, invoice_number?, raw_total_amount?,
     tax_amount?, tax_identifier?, reason (required) }
2. API Lambda (HandleCorrectDocument):
   - diffs the request against the existing DocumentItem
   - writes the changed fields + manually_corrected=true,
     corrected_by, corrected_at
   - writes one AuditLogItem PER changed field (old value, new value,
     reason, actor)
   - if vendor_name / raw_total_amount / document_date changed:
     re-enqueues run_reconciliation (see flow 1, step 4) — a stale
     match/score is never left in place after a correction
3. Response: the updated document, reflecting the new field values
   immediately (the re-reconciliation, if triggered, completes async).
```

## 4. Missing invoice detection (on-demand scan)

```
1. Browser: POST /api/v1/reconciliation/detect-missing-invoices
2. API Lambda calls internal/pipelines/exceptions.DetectMissingInvoices
   synchronously (not queued — it's a bounded per-tenant scan, not a
   per-document pipeline step):
   - lists UNMATCHED bank debits older than 5 days
   - lists every vendor name this tenant has ever uploaded an invoice for
   - fuzzy-matches each debit's narration against every vendor name
   - for matches above threshold, raises a MISSING_INVOICE anomaly
     (skipping transactions that already have one open)
3. Response: { bank_transactions_scanned, anomalies_created }
```

**Known gap**: this is on-demand only. No EventBridge/cron schedule
triggers it automatically yet — see `ROADMAP.md`.

## 5. Dashboard load (the daily business view)

```
Browser loads Dashboard tab → 5 parallel requests:
  - GET /reconciliation/dashboard-summary   (mismatch-count stats + AI insight paragraph)
  - GET /reconciliation/anomalies?status=OPEN
  - GET /bank-accounts, GET /tax-identifiers  (for the onboarding checklist)
  - GET /dashboard/insights                  (the ITC-risk business view — see below)

GET /dashboard/insights (internal/pipelines/dashboard/insights.go):
  - reads documents with gst_status IN (NOT_FILED, MISMATCH)
  - sorts by tax_amount desc → top 10 = "highest ITC risk today"
  - rolls the same set up by vendor → top 10 = "vendors requiring follow-up"
  - computes next GSTR-1 (11th) / GSTR-3B (20th) due dates from today's
    date → "filing deadlines" (flagged "approaching" if ≤7 days out)
  - sums tax_amount across that same set → "estimated recoverable ITC"
```

## 6. GST portal sync

```
1. Browser or scheduled trigger: POST /api/v1/gst/sync
2. internal/pipelines/gstsync calls the configured GST_API_* endpoint,
   compares vendor filing status (GSTR-2B) against uploaded invoices
3. Documents get gst_portal_status updated (FILED / NOT_FILED / MISMATCH)
   — this is what feeds both dashboard-summary's "GST Gaps" stat and
   dashboard/insights' ITC-risk/follow-up lists.
```

## 7. Reconciliation report export

```
Browser: GET /api/v1/reconciliation/export
→ streams a CSV (not JSON) directly in the HTTP response — see
  HandleExportReconciliationReport. The frontend's
  downloadReconciliationReport() (src/api.js) bypasses the shared JSON
  request() helper for this reason and triggers a browser file download
  from the response Blob.
```
