/**
 * GSTSyncView.jsx — real data from GET /api/v1/gst/vendor-status and
 * /api/v1/gst/itc-summary, plus a real trigger for /api/v1/gst/sync.
 */
import { useState, useEffect } from "react";
import { getVendorGSTStatus, getITCSummary, triggerGSTSync } from "../api";

function statusBadge(status) {
  const map = { FILED: "badge-verified", NOT_FILED: "badge-failed", MISMATCH: "badge-pending", PENDING: "badge-unverified" };
  return <span className={`badge-pill ${map[status] || "badge-unverified"}`}>{(status || "PENDING").replace("_", " ")}</span>;
}

export default function GSTSyncView({ onToast }) {
  const [vendors, setVendors] = useState([]);
  const [itc, setItc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  async function refresh() {
    const [v, i] = await Promise.all([getVendorGSTStatus(), getITCSummary()]);
    if (v?.vendors) setVendors(v.vendors);
    if (i?.itc_claimable_inr !== undefined) setItc(i);
    setLoading(false);
  }

  useEffect(() => { refresh(); }, []);

  async function handleSync() {
    setSyncing(true);
    const period = new Date().toISOString().slice(0, 7).replace("-", "").slice(2) + new Date().getFullYear();
    const mmYYYY = `${String(new Date().getMonth() + 1).padStart(2, "0")}${new Date().getFullYear()}`;
    const result = await triggerGSTSync(mmYYYY);
    setSyncing(false);
    if (result?.job_id) {
      onToast?.(`GST sync started for GSTIN ${result.gstin}`, "success");
      setTimeout(refresh, 4000);
    } else {
      onToast?.(result?.error || result?.detail || "Could not start sync", "error");
    }
  }

  if (loading) return <div className="card"><p style={{ color: "var(--text-gray)" }}>Loading…</p></div>;

  return (
    <>
      {itc && (
        <div style={{ display: "flex", gap: 16, marginBottom: 24 }}>
          <div className="card" style={{ flex: 1, marginBottom: 0, borderTop: "3px solid var(--primary-color)" }}>
            <div style={{ fontSize: 26, fontWeight: 800 }}>₹{Number(itc.itc_claimable_inr).toLocaleString("en-IN")}</div>
            <div style={{ fontSize: 13, color: "var(--text-gray)", marginTop: 4 }}>ITC Claimable</div>
          </div>
          <div className="card" style={{ flex: 1, marginBottom: 0, borderTop: "3px solid var(--danger-color)" }}>
            <div style={{ fontSize: 26, fontWeight: 800 }}>₹{Number(itc.itc_at_risk_inr).toLocaleString("en-IN")}</div>
            <div style={{ fontSize: 13, color: "var(--text-gray)", marginTop: 4 }}>ITC At Risk</div>
          </div>
        </div>
      )}

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <h3 style={{ fontSize: 18 }}>Vendor GST Status</h3>
          <button className="btn btn-primary" onClick={handleSync} disabled={syncing}>
            {syncing ? "Syncing…" : "↻ Sync GSTR-2B Now"}
          </button>
        </div>
        {vendors.length === 0 && <p style={{ color: "var(--text-gray)", fontSize: 13 }}>No vendor data yet — upload invoices to populate this list.</p>}
        {vendors.map((v, i) => (
          <div className="list-row" key={i}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{v.vendor_name}</span>
                {statusBadge(v.gst_portal_status)}
              </div>
              <div style={{ fontSize: 12, color: "var(--text-gray)", fontFamily: "monospace" }}>{v.gstin}</div>
            </div>
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>₹{Number(v.total_invoice_amount).toLocaleString("en-IN")}</div>
              <div style={{ fontSize: 11, color: "var(--text-gray)" }}>{v.invoice_count} invoice(s)</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
