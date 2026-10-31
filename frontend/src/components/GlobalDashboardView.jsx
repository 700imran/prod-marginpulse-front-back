/**
 * GlobalDashboardView.jsx — executive / international view of the SAME backend data the India dashboard uses.
 *
 * Connected endpoints (no new backend needed):
 *   GET  /reconciliation/dashboard-summary   KPIs, tax at risk
 *   GET  /reconciliation/dashboard-insights  supplier follow-up, recoverable tax, filing calendar
 *   GET  /reconciliation/anomalies           exception queue      POST …/anomaly/:id/resolve
 *   GET  /documents                          recent documents
 *   POST /documents/upload, /reconciliation/dataset-upload (PDF, images, XLSX, CSV, TSV, JSON, XML, TXT)
 *   POST /reconciliation/run                 re-run matching
 *
 * What it does NOT do: currency conversion. The ledger stores plain numbers, so the currency picker only
 * changes how amounts are labelled/grouped, and the page says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getDashboard, listAnomalies, getDashboardInsights, listDocuments, resolveAnomaly, triggerReconciliation,
  uploadDocument, uploadDataset, peekCached, PATHS,
} from "../api";
import { ACCEPT_ATTR, fileKind } from "../ingest/parseFile";
import { CURRENCIES, TERMS, formatMoney, formatDate, percent, humanizeType, sortBySeverity, executiveSummary } from "../global/format";
import { getRegion, setRegion as saveRegion, getCurrency, setCurrency as saveCurrency } from "../global/region";
import { printMarginPulseReport } from "../reporting/printReport";

const ok = (v) => v && typeof v === "object" && !v.error;
const listOf = (v) => (Array.isArray(v) ? v : Array.isArray(v?.items) ? v.items : []);
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

const SEVERITY_STYLE = {
  CRITICAL: { bg: "#fdecea", fg: "#b42318" }, HIGH: { bg: "#fff1e6", fg: "#b54708" },
  MEDIUM: { bg: "#fffaeb", fg: "#8a6100" }, LOW: { bg: "#eafbf5", fg: "#0f6e56" },
};

function Kpi({ label, value, hint, accent }) {
  return (
    <div className="card" style={{ marginBottom: 0, borderTop: `3px solid ${accent}` }}>
      <div style={{ fontSize: 28, fontWeight: 800, color: "var(--text-dark)", lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-gray)", marginTop: 6 }}>{label}</div>
      {hint && <div style={{ fontSize: 12, color: "var(--text-gray)", marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function Chip({ children, style }) {
  return <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 700, ...style }}>{children}</span>;
}

export default function GlobalDashboardView({ tenant, onToast }) {
  // First frame uses cached data when we have it (see api.peekCached) — no spinner on refresh.
  const [summary, setSummary] = useState(() => { const v = peekCached(PATHS.dashboard()); return ok(v) ? v : null; });
  const [insights, setInsights] = useState(() => { const v = peekCached(PATHS.insights()); return ok(v) ? v : null; });
  const [anomalies, setAnomalies] = useState(() => listOf(peekCached(PATHS.anomalies())));
  const [documents, setDocuments] = useState(() => listOf(peekCached(PATHS.documents())));
  const [loading, setLoading] = useState(() => !ok(peekCached(PATHS.dashboard())));
  const [loadError, setLoadError] = useState("");
  const [region, setRegionState] = useState(() => getRegion(tenant));
  const [currency, setCurrencyState] = useState(() => getCurrency(getRegion(tenant)));
  const [severity, setSeverity] = useState("ALL");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState([]);
  const fileInput = useRef(null);
  const terms = TERMS[region];

  const refresh = useCallback(async () => {
    try {
      const [s, a, i, d] = await Promise.all([getDashboard(), listAnomalies("OPEN"), getDashboardInsights(), listDocuments()]);
      if (ok(s)) { setSummary(s); setLoadError(""); } else setLoadError(s?.error || "Could not load the dashboard.");
      if (ok(a)) setAnomalies(listOf(a));
      if (ok(i)) setInsights(i);
      if (ok(d) || Array.isArray(d)) setDocuments(listOf(d));
    } catch {
      setLoadError("Could not reach the server. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const chooseRegion = (r) => { saveRegion(r); setRegionState(r); setCurrencyState(getCurrency(r)); };
  const chooseCurrency = (c) => { saveCurrency(c); setCurrencyState(c); };

  const m = summary?.summaryMetrics || {};
  const total = m.totalUploadedDocuments ?? 0;
  const reconciled = m.successfullyReconciledCount ?? 0;
  const taxAtRisk = num(summary?.itcAtRisk);
  const recoverable = num(insights?.estimatedRecoverableItc);
  const rate = percent(reconciled, total);
  const sorted = useMemo(() => sortBySeverity(anomalies), [anomalies]);
  const visible = severity === "ALL" ? sorted : sorted.filter((a) => a.severity === severity);
  const urgent = anomalies.filter((a) => a.severity === "CRITICAL" || a.severity === "HIGH").length;
  const money = (v, o) => formatMoney(v, currency, o);

  async function resolve(a) {
    setBusy(true);
    const r = await resolveAnomaly(a.anomalyId);
    setBusy(false);
    if (r && !r.error) { setAnomalies((list) => list.filter((x) => x.anomalyId !== a.anomalyId)); onToast?.("Exception resolved", "success"); refresh(); }
    else onToast?.(r?.error || "Could not resolve this exception", "error");
  }

  async function rerun() {
    setBusy(true);
    const r = await triggerReconciliation();
    setBusy(false);
    if (r && !r.error) { onToast?.(`Reconciliation started for ${r.documents_queued ?? 0} document(s)`, "success"); setTimeout(refresh, 1500); }
    else onToast?.(r?.error || "Could not start reconciliation", "error");
  }

  async function handleFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;
    setBusy(true);
    const results = [];
    for (const file of files) {
      const kind = fileKind(file);
      try {
        if (kind === "legacy-xls") results.push({ name: file.name, ok: false, msg: "Old .xls isn't supported — Save As .xlsx or .csv in Excel and upload again." });
        else if (kind === "unsupported") results.push({ name: file.name, ok: false, msg: "Unsupported type. Use PDF, image, XLSX, CSV, TSV, JSON, XML or TXT." });
        else if (kind === "data") {
          const r = await uploadDataset(file);
          if (r?.rowsImported != null) {
            const what = r.datasetType === "BANK_STATEMENT" ? "bank transactions" : "invoices";
            const rc = r.reconciliation || {};
            results.push({ name: file.name, ok: true, msg: `Imported ${r.rowsImported} ${what} — ${rc.reconciled ?? 0} reconciled, ${rc.review ?? 0} need review.` });
          } else results.push({ name: file.name, ok: false, msg: r?.error || "Could not import this file." });
        } else {
          const r = await uploadDocument(file, "INVOICE");
          results.push(r?.documentId ? { name: file.name, ok: true, msg: "Document uploaded and processed." } : { name: file.name, ok: false, msg: r?.error || "Upload failed." });
        }
      } catch {
        results.push({ name: file.name, ok: false, msg: "Upload failed — please try again." });
      }
    }
    setUploads(results);
    setBusy(false);
    if (results.some((r) => r.ok)) refresh();
  }

  function printReport() {
    const businessName = tenant?.businessName || tenant?.displayName || "Your workspace";
    printMarginPulseReport({
      title: "MarginPulse Global Finance Report",
      subtitle: `${businessName} · ${terms.region} view · amounts in ${currency}`,
      generatedAt: new Date(),
      summaryRows: [
        ["Documents processed", total], ["Reconciled automatically", `${reconciled} (${rate}%)`], ["Open exceptions", anomalies.length],
        [`${terms.inputTax} at risk`, money(taxAtRisk)], ["Estimated recoverable", money(recoverable)],
      ],
      sections: [
        { heading: "Open exceptions", rows: sorted.slice(0, 15).map((a) => [humanizeType(a.anomalyType, region), a.severity, a.description || "—"]).concat(sorted.length ? [] : [["None", "-", "Everything is reconciled."]]) },
        { heading: "Suppliers needing follow-up", rows: (insights?.vendorsRequiringFollowUp || []).slice(0, 10).map((v) => [v.vendorName, money(v.totalTaxAtRisk), `${v.openIssueCount} open issue(s)`]).concat((insights?.vendorsRequiringFollowUp || []).length ? [] : [["None", "-", "No supplier needs follow-up."]]) },
      ],
    });
  }

  if (loading) {
    return (
      <div className="view-skeleton" aria-busy="true" aria-label="Loading global dashboard">
        <div className="skeleton sk-title" /><div className="skeleton sk-row" /><div className="skeleton sk-row" /><div className="skeleton sk-row short" />
      </div>
    );
  }

  const deadlines = insights?.filingDeadlines || [];
  const suppliers = insights?.vendorsRequiringFollowUp || [];
  const btn = { padding: "8px 14px", borderRadius: 12, border: "1px solid var(--border-color, #e5e0d8)", background: "var(--card-bg, #fff)", fontWeight: 700, cursor: "pointer", fontSize: 13 };
  const seg = (active) => ({ ...btn, background: active ? "var(--primary-color)" : "var(--card-bg, #fff)", color: active ? "#fff" : "var(--text-dark)", borderColor: active ? "var(--primary-color)" : undefined });

  return (
    <div>
      <div className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: 22, marginBottom: 4 }}>Global Finance Overview</h2>
          <p style={{ fontSize: 13, color: "var(--text-gray)" }}>
            {terms.region} view{tenant?.businessName ? ` · ${tenant.businessName}` : ""} · amounts shown in {currency}, as recorded in your ledger (no currency conversion is applied).
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", maxWidth: "100%", minWidth: 0 }} role="group" aria-label="Display options">
          <button type="button" style={seg(region === "IN")} aria-pressed={region === "IN"} onClick={() => chooseRegion("IN")}>India · GST</button>
          <button type="button" style={seg(region === "GLOBAL")} aria-pressed={region === "GLOBAL"} onClick={() => chooseRegion("GLOBAL")}>Global · VAT</button>
          <label style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6, flex: "1 1 150px", minWidth: 0, maxWidth: "100%" }}>
            Currency
            <select aria-label="Display currency" value={currency} onChange={(e) => chooseCurrency(e.target.value)} style={{ ...btn, padding: "7px 10px", flex: 1, minWidth: 0, maxWidth: "100%" }}>
              {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.code} — {c.label}</option>)}
            </select>
          </label>
          <button type="button" style={btn} onClick={printReport}>Print report</button>
        </div>
      </div>

      {loadError && (
        <div className="card" role="alert" style={{ borderLeft: "4px solid #b42318" }}>
          <p style={{ fontSize: 14 }}>{loadError}</p>
          <button type="button" style={{ ...btn, marginTop: 10 }} onClick={() => { setLoading(true); refresh(); }}>Try again</button>
        </div>
      )}

      <div className="gd-kpis">
        <Kpi label="Reconciled automatically" value={`${rate}%`} hint={`${reconciled} of ${total} documents`} accent="var(--primary-color)" />
        <Kpi label="Open exceptions" value={anomalies.length} hint={urgent ? `${urgent} critical / high` : "None urgent"} accent={urgent ? "#b42318" : "#8a6100"} />
        <Kpi label={`${terms.inputTax} at risk`} value={money(taxAtRisk, { compact: true })} hint="Not yet verified with the tax authority" accent="#b54708" />
        <Kpi label="Estimated recoverable" value={money(recoverable, { compact: true })} hint="If flagged suppliers file" accent="#0f6e56" />
        <Kpi label="Documents processed" value={total} accent="#475467" />
      </div>

      <div className="card" aria-live="polite">
        <h3 style={{ fontSize: 16, marginBottom: 8 }}>Executive summary</h3>
        <p style={{ fontSize: 15, lineHeight: 1.6 }}>{executiveSummary({ total, reconciled, openCount: anomalies.length, taxAtRisk, recoverable, currency, terms })}</p>
      </div>

      <div className="gd-split">
        <div className="card" style={{ marginBottom: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <h3 style={{ fontSize: 16 }}>Exceptions needing review</h3>
            <div role="group" aria-label="Filter by severity" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW"].map((s) => (
                <button key={s} type="button" style={{ ...seg(severity === s), padding: "4px 10px", fontSize: 12 }} aria-pressed={severity === s} onClick={() => setSeverity(s)}>{s === "ALL" ? "All" : s[0] + s.slice(1).toLowerCase()}</button>
              ))}
            </div>
          </div>
          {visible.length === 0 ? (
            <p style={{ fontSize: 14, color: "var(--text-gray)" }}>{anomalies.length ? "No exceptions at this severity." : "All clear — nothing needs review."}</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {visible.slice(0, 12).map((a) => {
                const sv = SEVERITY_STYLE[a.severity] || SEVERITY_STYLE.LOW;
                return (
                  <li key={a.anomalyId} className="list-row" style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "12px 0", borderTop: "1px solid var(--border-color, #eee)" }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <Chip style={{ background: sv.bg, color: sv.fg }}>{a.severity}</Chip>
                        <strong style={{ fontSize: 14 }}>{humanizeType(a.anomalyType, region)}</strong>
                      </div>
                      <p style={{ fontSize: 13, color: "var(--text-gray)", marginTop: 4 }}>{a.description}</p>
                      {a.suggestedAction && <p style={{ fontSize: 13, marginTop: 2 }}><strong>Next step:</strong> {a.suggestedAction}</p>}
                    </div>
                    <button type="button" style={{ ...btn, alignSelf: "center", whiteSpace: "nowrap" }} disabled={busy} onClick={() => resolve(a)}>Mark resolved</button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="card" style={{ marginBottom: 0 }}>
          <h3 style={{ fontSize: 16, marginBottom: 12 }}>Suppliers needing follow-up</h3>
          {suppliers.length === 0 ? <p style={{ fontSize: 14, color: "var(--text-gray)" }}>No supplier currently needs follow-up.</p> : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {suppliers.slice(0, 6).map((v) => (
                <li key={v.vendorName} style={{ padding: "10px 0", borderTop: "1px solid var(--border-color, #eee)" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong style={{ fontSize: 14 }}>{v.vendorName}</strong>
                    <span style={{ fontSize: 14, fontWeight: 700 }}>{money(v.totalTaxAtRisk)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--text-gray)" }}>{v.openIssueCount} open issue{v.openIssueCount === 1 ? "" : "s"}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          <h3 style={{ fontSize: 16 }}>Add data</h3>
          <button type="button" style={btn} disabled={busy} onClick={rerun}>Re-run reconciliation</button>
        </div>
        <div
          role="button" tabIndex={0} aria-label="Upload files: click or drop here"
          onClick={() => fileInput.current?.click()}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.current?.click(); } }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer?.files); }}
          style={{ border: `2px dashed ${dragging ? "var(--primary-color)" : "var(--border-color, #d9d4cb)"}`, borderRadius: 16, padding: "28px 16px", textAlign: "center", cursor: "pointer", background: dragging ? "var(--primary-light)" : "transparent" }}
        >
          <p style={{ fontSize: 15, fontWeight: 700 }}>{busy ? "Working…" : "Drop invoices, statements or spreadsheets here"}</p>
          <p style={{ fontSize: 13, color: "var(--text-gray)", marginTop: 4 }}>PDF · images · XLSX · CSV · TSV · JSON · XML · TXT — or click to choose</p>
        </div>
        <input ref={fileInput} type="file" multiple accept={ACCEPT_ATTR} style={{ display: "none" }} data-testid="file-input"
          onChange={(e) => { const f = e.target.files; handleFiles(f); e.target.value = ""; }} />
        {uploads.length > 0 && (
          <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0" }} aria-live="polite">
            {uploads.map((u, i) => (
              <li key={i} style={{ fontSize: 13, padding: "4px 0", color: u.ok ? "#0f6e56" : "#b42318" }}><strong>{u.name}</strong> — {u.msg}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <h3 style={{ fontSize: 16, marginBottom: 12 }}>Recent documents</h3>
        {documents.length === 0 ? <p style={{ fontSize: 14, color: "var(--text-gray)" }}>No documents yet.</p> : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--text-gray)" }}>
                  <th style={{ padding: "6px 8px" }}>Supplier</th><th style={{ padding: "6px 8px" }}>Invoice</th><th style={{ padding: "6px 8px" }}>Date</th>
                  <th style={{ padding: "6px 8px", textAlign: "right" }}>Amount</th><th style={{ padding: "6px 8px", textAlign: "right" }}>Tax</th><th style={{ padding: "6px 8px" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {documents.slice(0, 8).map((d) => (
                  <tr key={d.documentId} style={{ borderTop: "1px solid var(--border-color, #eee)" }}>
                    <td style={{ padding: "8px" }}>{d.vendorName || d.originalFilename || "—"}</td>
                    <td style={{ padding: "8px" }}>{d.invoiceNumber || "—"}</td>
                    <td style={{ padding: "8px" }}>{formatDate(d.documentDate)}</td>
                    <td style={{ padding: "8px", textAlign: "right" }}>{d.rawTotalAmount != null ? money(num(d.rawTotalAmount)) : "—"}</td>
                    <td style={{ padding: "8px", textAlign: "right" }}>{d.taxAmount != null ? money(num(d.taxAmount)) : "—"}</td>
                    <td style={{ padding: "8px" }}><Chip style={{ background: d.processingStatus === "RECONCILED" ? "#eafbf5" : "#f2f4f7", color: d.processingStatus === "RECONCILED" ? "#0f6e56" : "#475467" }}>{String(d.processingStatus || "—").replace(/_/g, " ").toLowerCase()}</Chip></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ fontSize: 16, marginBottom: 8 }}>Compliance calendar</h3>
        {region === "IN" && deadlines.length > 0 ? (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {deadlines.slice(0, 6).map((f) => (
              <li key={`${f.returnType}-${f.period}`} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderTop: "1px solid var(--border-color, #eee)", fontSize: 14 }}>
                <span><strong>{f.returnType}</strong> · {f.period}</span>
                <span style={{ color: f.approaching ? "#b42318" : "var(--text-gray)", fontWeight: f.approaching ? 700 : 500 }}>{formatDate(f.dueDate)} · {f.daysRemaining} day{f.daysRemaining === 1 ? "" : "s"}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p style={{ fontSize: 14, color: "var(--text-gray)" }}>
            {region === "IN" ? "No upcoming filing deadlines." : "Filing calendars are available for Indian GST returns today. VAT and sales-tax calendars for other jurisdictions are not connected yet — switch to India · GST to see GST deadlines."}
          </p>
        )}
      </div>
    </div>
  );
}
