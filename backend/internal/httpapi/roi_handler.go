package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// Default assumptions behind the ROI estimate — deliberately exposed
// as overridable inputs (not hardcoded), and always echoed back in the
// response, so nobody mistakes "our default assumption" for "a
// guaranteed number". These are reasonable, commonly-cited planning
// assumptions, not audited figures:
//   - itcLeakageRatePercentDefault: share of GST paid to vendors that
//     typically ends up blocked/delayed due to vendor non-filing or
//     portal mismatches, before reconciliation catches it.
//   - timeSavedPercentDefault: share of manual reconciliation hours a
//     team typically no longer needs once matching is automated.
const (
	itcLeakageRatePercentDefault = 8.0
	timeSavedPercentDefault      = 70.0
)

type roiCalculatorRequest struct {
	MonthlyInvoiceVolume       float64  `json:"monthly_invoice_volume"`
	AvgInvoiceValueINR         float64  `json:"avg_invoice_value_inr"`
	AvgGSTRatePercent          *float64 `json:"avg_gst_rate_percent,omitempty"`
	HoursSpentManuallyPerMonth float64  `json:"hours_spent_manually_per_month"`
	HourlyCostINR              float64  `json:"hourly_cost_inr"`
	MonthlyPlanPriceINR        float64  `json:"monthly_plan_price_inr"`
	// Optional overrides for the two modeling assumptions above — if
	// omitted, the documented defaults are used and echoed back.
	ITCLeakageRatePercent *float64 `json:"itc_leakage_rate_percent,omitempty"`
	TimeSavedPercent      *float64 `json:"time_saved_percent,omitempty"`
}

type roiCalculatorResponse struct {
	Inputs struct {
		MonthlyInvoiceVolume       float64 `json:"monthly_invoice_volume"`
		AvgInvoiceValueINR         float64 `json:"avg_invoice_value_inr"`
		AvgGSTRatePercent          float64 `json:"avg_gst_rate_percent"`
		HoursSpentManuallyPerMonth float64 `json:"hours_spent_manually_per_month"`
		HourlyCostINR              float64 `json:"hourly_cost_inr"`
		MonthlyPlanPriceINR        float64 `json:"monthly_plan_price_inr"`
	} `json:"inputs"`
	AssumptionsUsed struct {
		ITCLeakageRatePercent float64 `json:"itc_leakage_rate_percent"`
		TimeSavedPercent      float64 `json:"time_saved_percent"`
		Note                  string  `json:"note"`
	} `json:"assumptions_used"`
	Results struct {
		MonthlyGSTValueINR              float64 `json:"monthly_gst_value_inr"`
		EstimatedMonthlyITCRecoveredINR float64 `json:"estimated_monthly_itc_recovered_inr"`
		HoursSavedPerMonth              float64 `json:"hours_saved_per_month"`
		MonthlyTimeSavingsINR           float64 `json:"monthly_time_savings_inr"`
		TotalMonthlyValueINR            float64 `json:"total_monthly_value_inr"`
		NetMonthlyROIInINR              float64 `json:"net_monthly_roi_inr"`
		ROIMultiple                     float64 `json:"roi_multiple"`
	} `json:"results"`
	Summary string `json:"summary"`
}

// HandleROICalculator mirrors POST /roi-calculator — deliberately
// unauthenticated (no RequireAuth wrapper) since it's meant to sit on
// the public marketing site as well as inside the logged-in dashboard,
// per the roadmap's "every visitor should immediately understand"
// requirement. Pure arithmetic, no persistence, no rate-limit-worthy
// cost.
func HandleROICalculator(w http.ResponseWriter, r *http.Request) {
	var req roiCalculatorRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		WriteError(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.MonthlyInvoiceVolume < 0 || req.AvgInvoiceValueINR < 0 || req.HoursSpentManuallyPerMonth < 0 ||
		req.HourlyCostINR < 0 || req.MonthlyPlanPriceINR < 0 {
		WriteError(w, http.StatusUnprocessableEntity, "Inputs must be non-negative")
		return
	}

	gstRate := 18.0
	if req.AvgGSTRatePercent != nil {
		gstRate = *req.AvgGSTRatePercent
	}
	itcLeakageRate := itcLeakageRatePercentDefault
	if req.ITCLeakageRatePercent != nil {
		itcLeakageRate = *req.ITCLeakageRatePercent
	}
	timeSavedRate := timeSavedPercentDefault
	if req.TimeSavedPercent != nil {
		timeSavedRate = *req.TimeSavedPercent
	}

	monthlyGSTValue := req.MonthlyInvoiceVolume * req.AvgInvoiceValueINR * (gstRate / 100)
	estimatedITCRecovered := monthlyGSTValue * (itcLeakageRate / 100)
	hoursSaved := req.HoursSpentManuallyPerMonth * (timeSavedRate / 100)
	timeSavingsINR := hoursSaved * req.HourlyCostINR
	totalMonthlyValue := estimatedITCRecovered + timeSavingsINR
	netROI := totalMonthlyValue - req.MonthlyPlanPriceINR
	roiMultiple := 0.0
	if req.MonthlyPlanPriceINR > 0 {
		roiMultiple = totalMonthlyValue / req.MonthlyPlanPriceINR
	}

	var resp roiCalculatorResponse
	resp.Inputs.MonthlyInvoiceVolume = req.MonthlyInvoiceVolume
	resp.Inputs.AvgInvoiceValueINR = req.AvgInvoiceValueINR
	resp.Inputs.AvgGSTRatePercent = gstRate
	resp.Inputs.HoursSpentManuallyPerMonth = req.HoursSpentManuallyPerMonth
	resp.Inputs.HourlyCostINR = req.HourlyCostINR
	resp.Inputs.MonthlyPlanPriceINR = req.MonthlyPlanPriceINR

	resp.AssumptionsUsed.ITCLeakageRatePercent = itcLeakageRate
	resp.AssumptionsUsed.TimeSavedPercent = timeSavedRate
	resp.AssumptionsUsed.Note = "These are editable planning assumptions, not guarantees — pass itc_leakage_rate_percent / time_saved_percent to override with your own numbers."

	resp.Results.MonthlyGSTValueINR = round2(monthlyGSTValue)
	resp.Results.EstimatedMonthlyITCRecoveredINR = round2(estimatedITCRecovered)
	resp.Results.HoursSavedPerMonth = round2(hoursSaved)
	resp.Results.MonthlyTimeSavingsINR = round2(timeSavingsINR)
	resp.Results.TotalMonthlyValueINR = round2(totalMonthlyValue)
	resp.Results.NetMonthlyROIInINR = round2(netROI)
	resp.Results.ROIMultiple = round2(roiMultiple)

	resp.Summary = fmt.Sprintf(
		"At this volume, MarginPulse could help recover roughly ₹%.0f in ITC and save %.0f hours (₹%.0f) of manual work per month — about ₹%.0f in total monthly value against a ₹%.0f plan cost.",
		resp.Results.EstimatedMonthlyITCRecoveredINR, resp.Results.HoursSavedPerMonth, resp.Results.MonthlyTimeSavingsINR,
		resp.Results.TotalMonthlyValueINR, req.MonthlyPlanPriceINR,
	)

	WriteJSON(w, http.StatusOK, resp)
}

func round2(v float64) float64 {
	return float64(int64(v*100+0.5)) / 100
}
