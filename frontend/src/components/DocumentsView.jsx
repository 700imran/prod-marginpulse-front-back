/**
 * DocumentsView.jsx — real data from GET /api/v1/documents, plus:
 *   - a detail panel (click any row) showing reconciliation evidence,
 *     the duplicate-invoice flag, and OCR/reconciliation confidence
 *   - the manual correction workflow (PATCH /documents/{id}/correct),
 *     which requires a reason and re-triggers reconciliation server-side
 *     when a reconciliation-relevant field changes
 *   - that document's audit trail (GET /documents/{id}/audit-log)
 */
import { useState, useEffect } from "react";
import { listDocuments, correctDocument, getDocumentAuditLog, downloadReconciliationReport } from "../api";
import { VerificationBadge } from "../theme";

const STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "RECONCILED", label: "Reconciled" },
  { value: "PARSED", label: "Parsed" },
  { value: "INGESTED", label: "Ingested" },
  { value: "FAILED", label: "Failed" },
];

const CORRECTABLE_FIELDS = [
  { key: "vendorName", label: "Vendor Name", type: "text" },
  { key: "documentDate", label: "Document Date", type: "date" },
  { key: "invoiceNumber", label: "Invoice Number", type: "text" },
  { key: "rawTotalAmount", label: "Total Amount (₹)", type: "number" },
  { key: "taxAmount", label: "Tax Amount (₹)", type: "number" },
  { key: "taxIdentifier", label: "GSTIN / Tax ID", type: "text" },
];

function statusBadge(status) {
  const map = {
    RECONCILED: "badge-verified",
    PARSED: "badge-pending",
    INGESTED: "badge-unverified",
    FAILED: "badge-failed",
  };
  return <span className={`badge-pill ${map[status] || "badge-unverified"}`}>{status}</span>;
}

function formatINR(amount) {
  if (!amount) return "—";
  return `₹${Number(amount).toLocaleString("en-IN")}`;
}

function Modal({ onClose, children, width = 560 }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(15,20,25,0.45)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "5vh 20px", zIndex: 200, overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card fade-in"
        style={{ width: "100%", maxWidth: width, marginBottom: 0 }}
      >
        {children}
      </div>
    </div>
  );
}

function AuditLogList({ entries }) {
  if (!entries) return <p style={{ fontSize: 13, color: "var(--text-gray)" }}>Loading audit trail…</p>;
  if (entries.length === 0) return <p style={{ fontSize: 13, color: "var(--text-gray)" }}>No changes recorded yet.</p>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {entries.map((e) => (
        <div key={e.auditLogId} style={{ fontSize: 12, padding: "10px 12px", background: "var(--bg-color)", borderRadius: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, marginBottom: 4 }}>
            <span>{e.action.replaceAll("_", " ")}</span>
            <span style={{ color: "var(--text-gray)", fontWeight: 600 }}>{new Date(e.createdAt).toLocaleString("en-IN")}</span>
          </div>
          {e.fieldName && (
            <div style={{ color: "var(--text-gray)" }}>
              <strong>{e.fieldName}</strong>: "{e.oldValue || "—"}" → "{e.newValue || "—"}"
            </div>
          )}
          {e.reason && <div style={{ color: "var(--text-gray)", marginTop: 2 }}>Reason: {e.reason}</div>}
          {e.actorEmail && <div style={{ color: "var(--text-gray)", marginTop: 2 }}>By {e.actorEmail}</div>}
        </div>
      ))}
    </div>
  );
}

/** Detail + manual-correction + audit-trail panel for one document. */
function DocumentDetailModal({ doc, onClose, onSaved, onToast }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() =>
    Object.fromEntries(CORRECTABLE_FIELDS.map((f) => [f.key, doc[f.key] ?? ""]))
  );
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [auditLog, setAuditLog] = useState(null);

  useEffect(() => {
    getDocumentAuditLog(doc.documentId).then((data) => setAuditLog(data?.items || []));
  }, [doc.documentId]);

  async function handleSave() {
    if (!reason.trim()) {
      onToast?.("Please explain why you're correcting this document", "error");
      return;
    }
    setSaving(true);
    const payload = { ...form };
    payload.rawTotalAmount = form.rawTotalAmount === "" ? undefined : Number(form.rawTotalAmount);
    payload.taxAmount = form.taxAmount === "" ? undefined : Number(form.taxAmount);
    const result = await correctDocument(doc.documentId, payload, reason);
    setSaving(false);
    if (result?.documentId) {
      onToast?.("Correction saved", "success");
      setEditing(false);
      setReason("");
      onSaved(result);
      getDocumentAuditLog(doc.documentId).then((data) => setAuditLog(data?.items || []));
    } else {
      onToast?.(result?.detail || "Could not save correction", "error");
    }
  }

  return (
    <Modal onClose={onClose}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
        <div>
          <h3 style={{ fontSize: 18 }}>{doc.vendorName || doc.originalFilename || "Document"}</h3>
          <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
            {statusBadge(doc.processingStatus)}
            {doc.manuallyCorrected && <span className="badge-pill badge-pending">Manually Corrected</span>}
            {doc.duplicateOfDocumentId && <span className="badge-pill badge-failed">Possible Duplicate</span>}
          </div>
        </div>
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
      </div>

      {doc.reconciliationReason && (
        <div style={{ background: "var(--bg-color)", borderRadius: 10, padding: "12px 14px", marginBottom: 16, fontSize: 13, color: "var(--text-dark)" }}>
          <strong>Reconciliation evidence:</strong> {doc.reconciliationReason}
        </div>
      )}
      {doc.duplicateOfDocumentId && (
        <div style={{ background: "rgba(255,91,91,0.08)", borderRadius: 10, padding: "12px 14px", marginBottom: 16, fontSize: 13, color: "var(--danger-color)" }}>
          Looks like a duplicate of document <code>{doc.duplicateOfDocumentId}</code> — confirm before including in ITC claims.
        </div>
      )}

      {!editing ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
            {CORRECTABLE_FIELDS.map((f) => (
              <div key={f.key}>
                <div style={{ fontSize: 11, color: "var(--text-gray)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{f.label}</div>
                <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2 }}>
                  {f.type === "number" ? formatINR(doc[f.key]) : (doc[f.key] || "—")}
                </div>
              </div>
            ))}
            <div>
              <div style={{ fontSize: 11, color: "var(--text-gray)", textTransform: "uppercase", letterSpacing: "0.04em" }}>OCR Confidence</div>
              <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2 }}>
                {doc.ocrConfidenceScore ? `${Math.round(doc.ocrConfidenceScore * 100)}%` : "—"}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: "var(--text-gray)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Reconciliation Score</div>
              <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2 }}>
                {doc.reconciliationScore ? `${Math.round(doc.reconciliationScore * 100)}%` : "—"}
              </div>
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => setEditing(true)}>Correct This Document</button>
        </>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }}>
            {CORRECTABLE_FIELDS.map((f) => (
              <div key={f.key} className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">{f.label}</label>
                <input
                  className="form-control"
                  type={f.type}
                  value={form[f.key]}
                  onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <div className="form-group">
            <label className="form-label">Reason for this correction (required)</label>
            <textarea
              className="form-control"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. OCR misread the invoice number from a blurry scan"
            />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : "Save Correction"}
            </button>
            <button className="btn btn-ghost" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
          </div>
        </>
      )}

      <div style={{ marginTop: 24, paddingTop: 20, borderTop: "1px solid var(--border-color)" }}>
        <h4 style={{ fontSize: 14, marginBottom: 12, color: "var(--text-gray)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Audit Trail
        </h4>
        <AuditLogList entries={auditLog} />
      </div>
    </Modal>
  );
}

export default function DocumentsView({ onToast }) {
  const [docs, setDocs] = useState([]);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectedDoc, setSelectedDoc] = useState(null);

  function load() {
    setLoading(true);
    listDocuments(filter || undefined).then((data) => {
      if (data?.items) { setDocs(data.items); setTotal(data.total); }
      setLoading(false);
    });
  }

  useEffect(() => { load(); }, [filter]);

  async function handleExport() {
    const ok = await downloadReconciliationReport();
    onToast?.(ok ? "Report downloaded" : "Could not generate report", ok ? "success" : "error");
  }

  function handleSaved(updatedDoc) {
    setDocs((prev) => prev.map((d) => (d.documentId === updatedDoc.documentId ? { ...d, ...updatedDoc } : d)));
    setSelectedDoc((prev) => (prev ? { ...prev, ...updatedDoc } : prev));
  }

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 10 }}>
        <h3 style={{ fontSize: 18 }}>Documents Matrix ({total})</h3>
        <div style={{ display: "flex", gap: 10 }}>
          <select className="form-control" style={{ width: 180 }} value={filter} onChange={(e) => setFilter(e.target.value)}>
            {STATUS_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          <button className="btn btn-ghost" onClick={handleExport}>Download Report (CSV)</button>
        </div>
      </div>

      {loading && <p style={{ color: "var(--text-gray)", fontSize: 13 }}>Loading…</p>}
      {!loading && docs.length === 0 && <p style={{ color: "var(--text-gray)", fontSize: 13 }}>No documents found.</p>}
      {!loading && docs.map((d) => (
        <div className="list-row" key={d.documentId} style={{ cursor: "pointer" }} onClick={() => setSelectedDoc(d)}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
              <span style={{ fontWeight: 700, fontSize: 14 }}>{d.vendorName || d.originalFilename || "Unknown vendor"}</span>
              {statusBadge(d.processingStatus)}
              {d.manuallyCorrected && <span className="badge-pill badge-pending">Corrected</span>}
              {d.duplicateOfDocumentId && <span className="badge-pill badge-failed">Duplicate?</span>}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-gray)" }}>
              {d.docType} · {d.documentDate || "no date"} · {d.taxIdentifier || "no tax ID"}
            </div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>{formatINR(d.rawTotalAmount)}</div>
            <div style={{ fontSize: 11, color: "var(--text-gray)" }}>{d.ingestChannel}</div>
          </div>
        </div>
      ))}

      {selectedDoc && (
        <DocumentDetailModal
          doc={selectedDoc}
          onClose={() => setSelectedDoc(null)}
          onSaved={handleSaved}
          onToast={onToast}
        />
      )}
    </div>
  );
}
