/**
 * ROICalculatorView.jsx — POST /api/v1/roi-calculator (public endpoint,
 * no auth required — same call works if this form is ever lifted onto
 * the public marketing site). Every visitor should immediately see
 * "if I spend ₹X on MarginPulse, how much ITC/time do I recover".
 */
import { useState } from "react";
import { calculateROI } from "../api";

const DEFAULTS = {
  monthly_invoice_volume: 150,
  avg_invoice_value_inr: 25000,
  avg_gst_rate_percent: 18,
  hours_spent_manually_per_month: 40,
  hourly_cost_inr: 400,
  monthly_plan_price_inr: 4999,
};

function Field({ label, value, onChange, suffix }) {
  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      <div style={{ position: "relative" }}>
        <input
          className="form-control"
          type="number"
          min="0"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {suffix && (
          <span style={{ position: "absolute", right: 16, top: "50%", transform: "translateY(-50%)", fontSize: 13, color: "var(--text-gray)", fontWeight: 600 }}>
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

function ResultStat({ label, value, accent }) {
  return (
    <div style={{ flex: "1 1 160px", padding: "16px 18px", borderRadius: 14, background: "var(--bg-color)", borderTop: `3px solid ${accent}` }}>
      <div style={{ fontSize: 22, fontWeight: 800 }}>{value}</div>
      <div style={{ fontSize: 12, color: "var(--text-gray)", marginTop: 4, fontWeight: 600 }}>{label}</div>
    </div>
  );
}

function formatINR(v) {
  return `₹${Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

export default function ROICalculatorView() {
  const [inputs, setInputs] = useState(DEFAULTS);
  const [advanced, setAdvanced] = useState(false);
  const [overrides, setOverrides] = useState({ itc_leakage_rate_percent: "", time_saved_percent: "" });
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  function setField(key, value) {
    setInputs((prev) => ({ ...prev, [key]: value }));
  }

  async function handleCalculate() {
    setLoading(true);
    const payload = {
      monthly_invoice_volume: Number(inputs.monthly_invoice_volume) || 0,
      avg_invoice_value_inr: Number(inputs.avg_invoice_value_inr) || 0,
      avg_gst_rate_percent: Number(inputs.avg_gst_rate_percent) || 0,
      hours_spent_manually_per_month: Number(inputs.hours_spent_manually_per_month) || 0,
      hourly_cost_inr: Number(inputs.hourly_cost_inr) || 0,
      monthly_plan_price_inr: Number(inputs.monthly_plan_price_inr) || 0,
    };
    if (overrides.itc_leakage_rate_percent !== "") payload.itc_leakage_rate_percent = Number(overrides.itc_leakage_rate_percent);
    if (overrides.time_saved_percent !== "") payload.time_saved_percent = Number(overrides.time_saved_percent);

    const data = await calculateROI(payload);
    setLoading(false);
    if (data?.results) setResult(data);
  }

  return (
    <div className="grid-2" style={{ gap: 24, alignItems: "flex-start" }}>
      <div className="card">
        <h3 style={{ fontSize: 18, marginBottom: 4 }}>ROI Calculator</h3>
        <p style={{ fontSize: 13, color: "var(--text-gray)", marginBottom: 20 }}>
          Estimate how much ITC and manual reconciliation time MarginPulse could recover for your business each month.
        </p>

        <Field label="Vendor invoices per month" value={inputs.monthly_invoice_volume} onChange={(v) => setField("monthly_invoice_volume", v)} />
        <Field label="Average invoice value" value={inputs.avg_invoice_value_inr} onChange={(v) => setField("avg_invoice_value_inr", v)} suffix="₹" />
        <Field label="Average GST rate" value={inputs.avg_gst_rate_percent} onChange={(v) => setField("avg_gst_rate_percent", v)} suffix="%" />
        <Field label="Hours spent on manual reconciliation per month" value={inputs.hours_spent_manually_per_month} onChange={(v) => setField("hours_spent_manually_per_month", v)} suffix="hrs" />
        <Field label="Blended hourly cost of that time" value={inputs.hourly_cost_inr} onChange={(v) => setField("hourly_cost_inr", v)} suffix="₹/hr" />
        <Field label="Your MarginPulse plan price" value={inputs.monthly_plan_price_inr} onChange={(v) => setField("monthly_plan_price_inr", v)} suffix="₹/mo" />

        <button
          type="button"
          onClick={() => setAdvanced((a) => !a)}
          style={{ background: "none", border: "none", color: "var(--primary-color)", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0, marginBottom: 16 }}
        >
          {advanced ? "Hide" : "Show"} advanced assumptions
        </button>

        {advanced && (
          <div style={{ background: "var(--bg-color)", borderRadius: 12, padding: 16, marginBottom: 20 }}>
            <p style={{ fontSize: 12, color: "var(--text-gray)", marginBottom: 12 }}>
              These are editable planning assumptions, not guarantees — leave blank to use our defaults (8% ITC leakage, 70% time saved).
            </p>
            <Field label="Assumed ITC leakage rate" value={overrides.itc_leakage_rate_percent} onChange={(v) => setOverrides((p) => ({ ...p, itc_leakage_rate_percent: v }))} suffix="%" />
            <Field label="Assumed time saved from automation" value={overrides.time_saved_percent} onChange={(v) => setOverrides((p) => ({ ...p, time_saved_percent: v }))} suffix="%" />
          </div>
        )}

        <button className="btn btn-primary" onClick={handleCalculate} disabled={loading} style={{ width: "100%" }}>
          {loading ? "Calculating…" : "Calculate My ROI"}
        </button>
      </div>

      <div className="card">
        <h3 style={{ fontSize: 18, marginBottom: 16 }}>Your Estimated Monthly Value</h3>
        {!result && <p style={{ fontSize: 13, color: "var(--text-gray)" }}>Fill in your numbers and calculate to see results here.</p>}
        {result && (
          <>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
              <ResultStat label="Estimated ITC Recovered" value={formatINR(result.results.estimated_monthly_itc_recovered_inr)} accent="var(--primary-color)" />
              <ResultStat label="Time Saved" value={`${result.results.hours_saved_per_month} hrs`} accent="#6366f1" />
              <ResultStat label="Time Savings Value" value={formatINR(result.results.monthly_time_savings_inr)} accent="#6366f1" />
              <ResultStat label="Net Monthly ROI" value={formatINR(result.results.net_monthly_roi_inr)} accent="var(--warning-color)" />
            </div>
            <div style={{ background: "var(--primary-light)", borderLeft: "4px solid var(--primary-color)", borderRadius: 10, padding: "14px 16px", marginBottom: 16 }}>
              <p style={{ fontSize: 14, lineHeight: 1.6 }}>{result.summary}</p>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-gray)" }}>
              ROI multiple: <strong>{result.results.roi_multiple}×</strong> your plan cost.
              <br />
              Assumptions used: {result.assumptions_used.itc_leakage_rate_percent}% ITC leakage, {result.assumptions_used.time_saved_percent}% time saved.
              <br />
              {result.assumptions_used.note}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
