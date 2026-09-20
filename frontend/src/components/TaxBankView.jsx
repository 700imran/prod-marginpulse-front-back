/**
 * TaxBankView.jsx — "Tax IDs & Bank Accounts" page. Real submit + verify
 * pipelines for GSTIN, PAN, and linked bank accounts.
 *
 * Verification is asynchronous: submitting shows PENDING immediately,
 * then this component polls the list every 4 seconds while anything is
 * still PENDING, so the UI honestly reflects that verification is a
 * real, separate step rather than instant — same principle as the
 * existing GST sync flow elsewhere in the app.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import {
  listTaxIdentifiers, addTaxIdentifier, reverifyTaxIdentifier, deleteTaxIdentifier, setPrimaryTaxIdentifier,
  listBankAccounts, linkBankAccount, reverifyBankAccount, unlinkBankAccount, setPrimaryBankAccount,
} from "../api";
import { VerificationBadge, Icons } from "../theme";

const ID_TYPES = [
  { value: "GSTIN", label: "GSTIN" },
  { value: "PAN", label: "PAN" },
  { value: "VAT", label: "VAT" },
  { value: "EIN", label: "EIN" },
  { value: "OTHER", label: "Other" },
];

function smallBtn(variant) {
  const base = { padding: "6px 12px", fontSize: 12, borderRadius: 8 };
  if (variant === "ghost") return { ...base, background: "var(--bg-color)", color: "var(--text-gray)", border: "none", cursor: "pointer", fontWeight: 600 };
  if (variant === "danger") return { ...base, background: "rgba(255,91,91,0.1)", color: "var(--danger-color)", border: "none", cursor: "pointer", fontWeight: 600 };
  return { ...base, background: "var(--primary-color)", color: "#fff", border: "none", cursor: "pointer", fontWeight: 600 };
}

export default function TaxBankView({ onToast }) {
  const [taxIds, setTaxIds] = useState([]);
  const [bankAccounts, setBankAccounts] = useState([]);
  const [loading, setLoading] = useState(true);

  const [taxForm, setTaxForm] = useState({ id_type: "GSTIN", id_value: "", label: "" });
  const [taxSubmitting, setTaxSubmitting] = useState(false);
  const [taxError, setTaxError] = useState("");

  const [bankForm, setBankForm] = useState({ bank_name: "", account_holder_name: "", account_number: "", ifsc_code: "", account_type: "CURRENT" });
  const [bankSubmitting, setBankSubmitting] = useState(false);
  const [bankError, setBankError] = useState("");

  const pollRef = useRef(null);

  const refresh = useCallback(async () => {
    const [tx, banks] = await Promise.all([listTaxIdentifiers(), listBankAccounts()]);
    if (Array.isArray(tx)) setTaxIds(tx);
    if (Array.isArray(banks)) setBankAccounts(banks);
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  // Poll while anything is PENDING — stops automatically once everything
  // has resolved to VERIFIED/FAILED, so this doesn't poll forever.
  useEffect(() => {
    const hasPending = taxIds.some((t) => t.verificationStatus === "PENDING") ||
                        bankAccounts.some((b) => b.verificationStatus === "PENDING");
    if (hasPending && !pollRef.current) {
      pollRef.current = setInterval(refresh, 4000);
    } else if (!hasPending && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [taxIds, bankAccounts, refresh]);

  async function handleAddTaxId(e) {
    e.preventDefault();
    setTaxSubmitting(true);
    setTaxError("");
    const result = await addTaxIdentifier(taxForm.id_type, taxForm.id_value.trim(), taxForm.label || null);
    if (result?.taxIdentifierId) {
      setTaxIds((prev) => [result, ...prev]);
      setTaxForm({ id_type: "GSTIN", id_value: "", label: "" });
      onToast?.(`${result.idType} submitted — verification in progress`, "success");
    } else {
      setTaxError(result?.detail || "Could not submit — check the format and try again");
    }
    setTaxSubmitting(false);
  }

  async function handleReverifyTax(id) {
    const result = await reverifyTaxIdentifier(id);
    if (result?.taxIdentifierId) {
      setTaxIds((prev) => prev.map((t) => (t.taxIdentifierId === id ? result : t)));
      onToast?.("Re-verification started", "success");
    }
  }

  async function handleDeleteTax(id) {
    const ok = await deleteTaxIdentifier(id);
    if (ok) {
      setTaxIds((prev) => prev.filter((t) => t.taxIdentifierId !== id));
      onToast?.("Tax identifier removed", "success");
    }
  }

  async function handleSetPrimaryTax(id) {
    const result = await setPrimaryTaxIdentifier(id);
    if (result?.taxIdentifierId) refresh();
  }

  async function handleLinkBank(e) {
    e.preventDefault();
    setBankSubmitting(true);
    setBankError("");
    const result = await linkBankAccount(bankForm);
    if (result?.bankAccountId) {
      setBankAccounts((prev) => [result, ...prev]);
      setBankForm({ bank_name: "", account_holder_name: "", account_number: "", ifsc_code: "", account_type: "CURRENT" });
      onToast?.("Bank account linked — verification in progress", "success");
    } else {
      setBankError(result?.detail || "Could not link account — check the details and try again");
    }
    setBankSubmitting(false);
  }

  async function handleReverifyBank(id) {
    const result = await reverifyBankAccount(id);
    if (result?.bankAccountId) {
      setBankAccounts((prev) => prev.map((b) => (b.bankAccountId === id ? result : b)));
      onToast?.("Re-verification started", "success");
    }
  }

  async function handleUnlinkBank(id) {
    const ok = await unlinkBankAccount(id);
    if (ok) {
      setBankAccounts((prev) => prev.filter((b) => b.bankAccountId !== id));
      onToast?.("Bank account unlinked", "success");
    }
  }

  async function handleSetPrimaryBank(id) {
    const result = await setPrimaryBankAccount(id);
    if (result?.bankAccountId) refresh();
  }

  if (loading) {
    return <div className="card"><p style={{ color: "var(--text-gray)" }}>Loading…</p></div>;
  }

  return (
    <>
      {/* ── Tax Identifiers ── */}
      <div className="card">
        <h3 style={{ marginBottom: 6, fontSize: 18 }}>Tax Identifiers</h3>
        <p style={{ color: "var(--text-gray)", fontSize: 13, marginBottom: 20 }}>
          Add your GSTIN, PAN, or other tax registration numbers. Each submission is verified
          against the relevant government API — this can take a few seconds.
        </p>

        <form onSubmit={handleAddTaxId} style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
          <select
            className="form-control"
            style={{ width: 110 }}
            value={taxForm.id_type}
            onChange={(e) => setTaxForm((f) => ({ ...f, id_type: e.target.value }))}
          >
            {ID_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <input
            className="form-control"
            style={{ flex: 1, minWidth: 200 }}
            placeholder={taxForm.id_type === "GSTIN" ? "08AAAAA0000A1Z1" : taxForm.id_type === "PAN" ? "AAAAA0000A" : "Identifier value"}
            value={taxForm.id_value}
            onChange={(e) => setTaxForm((f) => ({ ...f, id_value: e.target.value.toUpperCase() }))}
            maxLength={32}
            required
          />
          <input
            className="form-control"
            style={{ width: 160 }}
            placeholder="Label (optional)"
            value={taxForm.label}
            onChange={(e) => setTaxForm((f) => ({ ...f, label: e.target.value }))}
            maxLength={128}
          />
          <button type="submit" className="btn btn-primary" disabled={taxSubmitting || !taxForm.id_value.trim()}>
            <span className="icon-wrapper"><Icons.Plus /></span>
            {taxSubmitting ? "Submitting…" : "Add"}
          </button>
        </form>
        {taxError && <div className="inline-error" style={{ marginBottom: 16 }}>{taxError}</div>}

        {taxIds.length === 0 && (
          <p style={{ color: "var(--text-gray)", fontSize: 13 }}>No tax identifiers added yet.</p>
        )}
        {taxIds.map((t) => (
          <div className="list-row" key={t.taxIdentifierId}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{t.idType}</span>
                <span style={{ fontFamily: "monospace", fontSize: 13, color: "var(--text-dark)" }}>{t.idValue}</span>
                {t.isPrimary && <span className="badge-pill badge-verified">Primary</span>}
                <VerificationBadge status={t.verificationStatus} />
              </div>
              {t.label && <div style={{ fontSize: 12, color: "var(--text-gray)" }}>{t.label}</div>}
              {t.verifiedLegalName && <div style={{ fontSize: 12, color: "var(--text-gray)" }}>Registered name: {t.verifiedLegalName}</div>}
              {t.verificationError && <div className="inline-error" style={{ marginTop: 2 }}>{t.verificationError}</div>}
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              {!t.isPrimary && (
                <button style={smallBtn("ghost")} onClick={() => handleSetPrimaryTax(t.taxIdentifierId)}>Set Primary</button>
              )}
              {(t.verificationStatus === "PENDING" || t.verificationStatus === "FAILED") && (
                <button style={smallBtn("ghost")} onClick={() => handleReverifyTax(t.taxIdentifierId)}>Re-verify</button>
              )}
              <button style={smallBtn("danger")} onClick={() => handleDeleteTax(t.taxIdentifierId)}>Remove</button>
            </div>
          </div>
        ))}
      </div>

      {/* ── Bank Accounts ── */}
      <div className="card">
        <h3 style={{ marginBottom: 6, fontSize: 18 }}>Linked Bank Accounts</h3>
        <p style={{ color: "var(--text-gray)", fontSize: 13, marginBottom: 20 }}>
          Connect a bank account to enable automated reconciliation. Account numbers are
          encrypted before storage — only the last 4 digits are ever shown.
        </p>

        <form onSubmit={handleLinkBank}>
          <div className="grid-2" style={{ marginBottom: 16 }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Bank Name</label>
              <input className="form-control" value={bankForm.bank_name} onChange={(e) => setBankForm((f) => ({ ...f, bank_name: e.target.value }))} maxLength={128} required />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Account Holder Name</label>
              <input className="form-control" value={bankForm.account_holder_name} onChange={(e) => setBankForm((f) => ({ ...f, account_holder_name: e.target.value }))} maxLength={255} required />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">Account Number</label>
              <input className="form-control" value={bankForm.account_number} onChange={(e) => setBankForm((f) => ({ ...f, account_number: e.target.value.replace(/\D/g, "") }))} maxLength={20} required />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label">IFSC Code</label>
              <input className="form-control" value={bankForm.ifsc_code} onChange={(e) => setBankForm((f) => ({ ...f, ifsc_code: e.target.value.toUpperCase() }))} maxLength={11} placeholder="HDFC0001234" required />
            </div>
          </div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 16 }}>
            <select
              className="form-control"
              style={{ width: 160 }}
              value={bankForm.account_type}
              onChange={(e) => setBankForm((f) => ({ ...f, account_type: e.target.value }))}
            >
              <option value="CURRENT">Current</option>
              <option value="SAVINGS">Savings</option>
              <option value="OD">Overdraft</option>
              <option value="OTHER">Other</option>
            </select>
            <button type="submit" className="btn btn-primary" disabled={bankSubmitting}>
              {bankSubmitting ? "Linking…" : "Link Account"}
            </button>
          </div>
        </form>
        {bankError && <div className="inline-error" style={{ marginTop: 12 }}>{bankError}</div>}

        <div style={{ marginTop: 20 }}>
          {bankAccounts.length === 0 && (
            <p style={{ color: "var(--text-gray)", fontSize: 13 }}>No bank accounts linked yet.</p>
          )}
          {bankAccounts.map((b) => (
            <div className="list-row" key={b.bankAccountId}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{b.bankName}</span>
                  <span style={{ fontFamily: "monospace", fontSize: 13 }}>•••• {b.accountNumberLast4}</span>
                  {b.isPrimary && <span className="badge-pill badge-verified">Primary</span>}
                  <VerificationBadge status={b.verificationStatus} />
                </div>
                <div style={{ fontSize: 12, color: "var(--text-gray)" }}>
                  {b.accountHolderName} · {b.ifscCode} · {b.accountType}
                </div>
                {b.verificationError && <div className="inline-error" style={{ marginTop: 2 }}>{b.verificationError}</div>}
              </div>
              <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                {!b.isPrimary && (
                  <button style={smallBtn("ghost")} onClick={() => handleSetPrimaryBank(b.bankAccountId)}>Set Primary</button>
                )}
                {(b.verificationStatus === "PENDING" || b.verificationStatus === "FAILED") && (
                  <button style={smallBtn("ghost")} onClick={() => handleReverifyBank(b.bankAccountId)}>Re-verify</button>
                )}
                <button style={smallBtn("danger")} onClick={() => handleUnlinkBank(b.bankAccountId)}>Unlink</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
