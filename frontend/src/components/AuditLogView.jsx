/**
 * AuditLogView.jsx — GET /api/v1/audit-log, tenant-wide. For a single
 * document's history, see the audit trail section inside
 * DocumentsView.jsx's detail modal instead — this view is the
 * "everything, across every document/anomaly/bank transaction" list.
 */
import { useState, useEffect } from "react";
import { getAuditLog } from "../api";

const ENTITY_FILTERS = [
  { value: "", label: "All entities" },
  { value: "DOCUMENT", label: "Documents" },
  { value: "ANOMALY", label: "Anomalies" },
  { value: "BANKTXN", label: "Bank Transactions" },
];

export default function AuditLogView() {
  const [entries, setEntries] = useState([]);
  const [entityType, setEntityType] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getAuditLog(entityType || undefined, undefined, 200).then((data) => {
      setEntries(data?.items || []);
      setLoading(false);
    });
  }, [entityType]);

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <div>
          <h3 style={{ fontSize: 18 }}>Audit Trail</h3>
          <p style={{ fontSize: 13, color: "var(--text-gray)", marginTop: 4 }}>
            Every manual correction, anomaly resolution, and auto-detected exception — who changed what, when, and why.
          </p>
        </div>
        <select className="form-control" style={{ width: 200 }} value={entityType} onChange={(e) => setEntityType(e.target.value)}>
          {ENTITY_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </div>

      {loading && <p style={{ fontSize: 13, color: "var(--text-gray)" }}>Loading…</p>}
      {!loading && entries.length === 0 && <p style={{ fontSize: 13, color: "var(--text-gray)" }}>No audit entries yet.</p>}
      {!loading && entries.map((e) => (
        <div className="list-row" key={e.audit_log_id} style={{ alignItems: "flex-start" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>{e.action.replaceAll("_", " ")}</span>
              <span className="badge-pill badge-unverified">{e.entity_type}</span>
            </div>
            {e.field_name && (
              <p style={{ fontSize: 13, color: "var(--text-gray)" }}>
                <strong>{e.field_name}</strong>: "{e.old_value || "—"}" → "{e.new_value || "—"}"
              </p>
            )}
            {e.reason && <p style={{ fontSize: 13, color: "var(--text-gray)" }}>Reason: {e.reason}</p>}
            <p style={{ fontSize: 11, color: "var(--text-gray)", marginTop: 4 }}>
              {e.entity_id} {e.actor_email ? `· by ${e.actor_email}` : ""}
            </p>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-gray)", flexShrink: 0, textAlign: "right" }}>
            {new Date(e.created_at).toLocaleString("en-IN")}
          </div>
        </div>
      ))}
    </div>
  );
}
