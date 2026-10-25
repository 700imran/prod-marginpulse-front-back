/**
 * ReconciliationRulesView.jsx — real load/save against
 * GET/PATCH /api/v1/settings/reconciliation.
 */
import { useState, useEffect } from "react";
import { getReconciliationSettings, updateReconciliationSettings } from "../api";
import { Toggle } from "../theme";

function toPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return num > 1 ? num : num * 100;
}

function toDecimal(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return num > 1 ? num / 100 : num;
}

export default function ReconciliationRulesView({ onToast }) {
  const [settings, setSettings] = useState(null);
  const [threshold, setThreshold] = useState(75);
  const [dateDriftTolerance, setDateDriftTolerance] = useState(3);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getReconciliationSettings().then((data) => {
      if (data) {
        setSettings(data);
        setThreshold(toPercent(data.ocrConfidenceThreshold ?? 0.75));
        setDateDriftTolerance(Number(data.dateDriftToleranceDays ?? 3));
      }
      setLoading(false);
    });
  }, []);

  async function patch(fields) {
    setSaving(true);

    const payload = { ...fields };
    if (Object.prototype.hasOwnProperty.call(payload, "ocrConfidenceThreshold")) {
      payload.ocrConfidenceThreshold = toDecimal(payload.ocrConfidenceThreshold);
    }
    if (Object.prototype.hasOwnProperty.call(payload, "dateDriftToleranceDays")) {
      payload.dateDriftToleranceDays = Number(payload.dateDriftToleranceDays);
    }

    const updated = await updateReconciliationSettings(payload);
    if (updated) {
      setSettings(updated);
      setThreshold(toPercent(updated.ocrConfidenceThreshold ?? 0.75));
      setDateDriftTolerance(Number(updated.dateDriftToleranceDays ?? 3));
      onToast?.("Reconciliation rules updated", "success");
    } else {
      onToast?.(updated?.detail || "Could not save", "error");
    }
    setSaving(false);
  }

  function handleThresholdBlur() {
    const num = Math.max(0, Math.min(100, Number.parseFloat(threshold) || 0));
    setThreshold(num);
    patch({ ocrConfidenceThreshold: num });
  }

  if (loading) return <div className="card"><p style={{ color: "var(--text-gray)" }}>Loading…</p></div>;

  return (
    <>
      <div className="card">
        <h3 style={{ marginBottom: 24, fontSize: 18 }}>AI Matching Parameters</h3>
        <Toggle
          title="Fuzzy Vendor Matching"
          desc="Allow AI to match variations of names (e.g., 'TechServe' and 'TechServe Pvt Ltd')."
          checked={!!settings?.fuzzyVendorMatching}
          onChange={(v) => { setSettings((s) => ({ ...s, fuzzyVendorMatching: v })); patch({ fuzzyVendorMatching: v }); }}
          disabled={saving}
        />

        <div className="form-group" style={{ marginTop: 24, maxWidth: 300 }}>
          <label className="form-label">Date Drift Tolerance (days)</label>
          <input
            type="number"
            className="form-control"
            value={dateDriftTolerance}
            min={0}
            max={30}
            onChange={(e) => setDateDriftTolerance(e.target.value)}
            onBlur={() => patch({ dateDriftToleranceDays: Number(dateDriftTolerance) })}
          />
          <p style={{ fontSize: 12, color: "var(--text-gray)", marginTop: 8 }}>
            Allow matching if bank statement date is within this many days of the invoice date.
          </p>
        </div>

        <div className="form-group" style={{ marginTop: 24, maxWidth: 300 }}>
          <label className="form-label">OCR Confidence Threshold (%)</label>
          <input
            type="number"
            className="form-control"
            value={threshold}
            min={0}
            max={100}
            onChange={(e) => setThreshold(e.target.value)}
            onBlur={handleThresholdBlur}
          />
          <p style={{ fontSize: 12, color: "var(--text-gray)", marginTop: 8 }}>
            Require manual review if document extraction score is below this.
          </p>
        </div>
      </div>
      <div className="card pro-block">
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <h3 style={{ fontSize: 18 }}>Multi-currency Reconciliation</h3>
          <span className="nav-badge badge-pro" style={{ padding: "4px 8px" }}>Pro Feature</span>
        </div>
        <p style={{ color: "var(--text-gray)", marginTop: 10 }}>
          Auto-calculate forex variance based on historical settlement dates.
        </p>
      </div>
    </>
  );
}
