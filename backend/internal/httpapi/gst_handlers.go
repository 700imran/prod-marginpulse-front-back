package httpapi

import (
	"log/slog"
	"net/http"
	"sort"

	"github.com/marginpulse/backend/internal/queue"
	"github.com/marginpulse/backend/internal/repository"
)

// HandleTriggerGSTSync mirrors POST /gst/sync?period=MMYYYY — period is
// a query param (matching the frontend's call shape), not a JSON body.
func HandleTriggerGSTSync(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	period := r.URL.Query().Get("period")
	if tc.Tenant.GSTINNumber == "" {
		WriteError(w, http.StatusBadRequest, "No GSTIN registered for this account")
		return
	}
	jobID, err := queue.EnqueueGSTSync(r.Context(), tc.Tenant.TenantID, tc.Tenant.GSTINNumber, period)
	if err != nil {
		slog.Error("failed to enqueue GST sync", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not start GST sync")
		return
	}
	WriteJSON(w, http.StatusAccepted, map[string]string{"job_id": jobID, "gstin": tc.Tenant.GSTINNumber})
}

type vendorStatusOut struct {
	VendorName         string  `json:"vendor_name"`
	GSTIN              string  `json:"gstin"`
	InvoiceCount       int     `json:"invoice_count"`
	TotalInvoiceAmount float64 `json:"total_invoice_amount"`
	GSTPortalStatus    string  `json:"gst_portal_status"`
}

// worseStatus ranks GST statuses worst-first so a vendor with even one
// problem invoice shows that problem rather than being hidden by other
// invoices that are fine — a compliance dashboard should surface risk,
// not average it away.
func worseStatus(a, b string) string {
	rank := map[string]int{"MISMATCH": 3, "NOT_FILED": 2, "PENDING": 1, "FILED": 0, "": 1}
	if rank[b] > rank[a] {
		return b
	}
	return a
}

// HandleVendorStatus mirrors GET /gst/vendor-status — groups all
// invoices-with-a-GSTIN by vendor and reports ONE overall status per
// vendor (worst-of, see worseStatus) rather than a per-status breakdown.
func HandleVendorStatus(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	docsRepo := repository.NewDocumentsRepo()
	docs, err := docsRepo.ListInvoicesWithTaxIdentifier(r.Context(), tc.Tenant.TenantID)
	if err != nil {
		slog.Error("vendor status query failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not load vendor status")
		return
	}

	byVendor := map[string]*vendorStatusOut{}
	var order []string
	for _, d := range docs {
		key := d.TaxIdentifier
		v, ok := byVendor[key]
		if !ok {
			v = &vendorStatusOut{VendorName: d.VendorName, GSTIN: d.TaxIdentifier, GSTPortalStatus: "PENDING"}
			byVendor[key] = v
			order = append(order, key)
		}
		v.InvoiceCount++
		v.TotalInvoiceAmount += d.RawTotalAmount
		v.GSTPortalStatus = worseStatus(v.GSTPortalStatus, d.GSTPortalStatus)
	}

	sort.Strings(order)
	out := make([]vendorStatusOut, 0, len(order))
	for _, k := range order {
		out = append(out, *byVendor[k])
	}
	WriteJSON(w, http.StatusOK, map[string]interface{}{"vendors": out})
}

// HandleITCSummary mirrors GET /gst/itc-summary.
func HandleITCSummary(w http.ResponseWriter, r *http.Request, tc *TenantContext) {
	docsRepo := repository.NewDocumentsRepo()

	filed, err := docsRepo.ListByGSTStatus(r.Context(), tc.Tenant.TenantID, "FILED")
	if err != nil {
		slog.Error("itc summary: FILED query failed", "error", err)
		WriteError(w, http.StatusInternalServerError, "Could not load ITC summary")
		return
	}
	notFiled, err := docsRepo.ListByGSTStatus(r.Context(), tc.Tenant.TenantID, "NOT_FILED")
	if err != nil {
		slog.Error("itc summary: NOT_FILED query failed", "error", err)
		notFiled = nil
	}
	mismatch, err := docsRepo.ListByGSTStatus(r.Context(), tc.Tenant.TenantID, "MISMATCH")
	if err != nil {
		slog.Error("itc summary: MISMATCH query failed", "error", err)
		mismatch = nil
	}

	var claimable, atRisk float64
	for _, d := range filed {
		claimable += d.TaxAmount
	}
	for _, d := range append(notFiled, mismatch...) {
		atRisk += d.TaxAmount
	}

	WriteJSON(w, http.StatusOK, map[string]interface{}{
		"itc_claimable_inr": claimable, "itc_at_risk_inr": atRisk,
	})
}
