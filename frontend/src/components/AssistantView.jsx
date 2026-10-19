/**
 * AssistantView.jsx — natural-language assistant (POST /api/v1/assistant/*).
 * Design/safety model: backend-cloudflare/WORKFLOW.md.
 *
 * Rules this component must keep:
 *  - Render every assistant string and every confirmation summary as plain
 *    text (React text nodes). They can contain text that originated in
 *    uploaded documents; never use dangerouslySetInnerHTML or markdown→HTML.
 *  - Anything that changes data happens only when the user presses the
 *    Confirm button on a confirm_action card — that sends the signed token
 *    to /assistant/confirm. The model's text never triggers an action.
 *  - Never put the confirmation token into the transcript or conversation
 *    history (see buildHistory).
 */
import { useState, useRef, useEffect } from "react";
import { assistantMessage, assistantConfirm } from "../api";
import { buildHistory, describeError, isExpired, MAX_MESSAGE_CHARS, SUGGESTIONS } from "./assistantLogic";

export default function AssistantView({ onNavigate }) {
  const [messages, setMessages] = useState([]);       // {role, content, kind?, action?}
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);        // confirm_action reply, or null
  const [confirming, setConfirming] = useState(false);
  const [credits, setCredits] = useState(null);
  const [, forceTick] = useState(0);
  const endRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView?.({ behavior: "smooth" }); }, [messages, pending]);

  // Re-render once a pending proposal's token expires so its buttons disable.
  useEffect(() => {
    if (!pending) return undefined;
    const ms = Math.max(0, pending.expires_at * 1000 - Date.now() - 5000) + 250;
    const t = setTimeout(() => forceTick((n) => n + 1), ms);
    return () => clearTimeout(t);
  }, [pending]);

  const push = (m) => setMessages((prev) => [...prev, m]);

  async function send(text) {
    const message = text.trim();
    if (!message || busy || message.length > MAX_MESSAGE_CHARS) return;
    const history = buildHistory(messages);
    setInput("");
    setPending(null); // a new question supersedes any unconfirmed proposal
    push({ role: "user", content: message });
    setBusy(true);
    const res = await assistantMessage(message, history);
    setBusy(false);

    if (res.status === 200 && res.body) {
      if (typeof res.body.credits_remaining === "number") setCredits(res.body.credits_remaining);
      if (res.body.type === "confirm_action") {
        setPending(res.body);
        return;
      }
      push({ role: "assistant", content: String(res.body.message ?? "") });
      return;
    }
    const n = describeError(res);
    push({ role: "assistant", kind: "error", content: n.text, action: n.action });
  }

  async function confirm() {
    if (!pending || confirming || isExpired(pending.expires_at)) return;
    const proposal = pending;
    setConfirming(true);
    const res = await assistantConfirm(proposal.confirmation_token);
    setConfirming(false);
    setPending(null); // token is single-use whatever the outcome
    if (res.status === 200 && res.body?.type === "action_result") {
      push({ role: "assistant", kind: "result", content: String(res.body.message ?? "Done.") });
      return;
    }
    const n = describeError(res);
    push({ role: "assistant", kind: "error", content: n.text, action: n.action });
  }

  function cancel() {
    setPending(null);
    push({ role: "assistant", kind: "notice", content: "Okay — nothing was changed." });
  }

  const expired = pending ? isExpired(pending.expires_at) : false;

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 420 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, gap: 10, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ fontSize: 18 }}>Assistant</h3>
          <p style={{ fontSize: 13, color: "var(--text-gray)", marginTop: 4 }}>
            Ask about your reconciliation data in plain English. Each question uses usage credits.
          </p>
        </div>
        {credits !== null && <span className="badge-pill badge-unverified">{credits} credits left</span>}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "4px 2px" }} aria-live="polite">
        {messages.length === 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="btn btn-ghost" style={{ fontSize: 13 }} disabled={busy} onClick={() => send(s)}>{s}</button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", margin: "8px 0" }}>
            <div
              style={{
                maxWidth: "80%", padding: "10px 14px", borderRadius: 14, fontSize: 14, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word",
                background: m.role === "user" ? "var(--primary-color)" : m.kind === "error" ? "#fef2f2" : "var(--card-bg)",
                color: m.role === "user" ? "#fff" : m.kind === "error" ? "var(--danger-color)" : "var(--text-dark)",
                border: m.role === "user" ? "none" : "1px solid var(--border-color)",
              }}
            >
              {m.content}
              {m.action === "billing" && onNavigate && (
                <div style={{ marginTop: 8 }}>
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => onNavigate("billing")}>Go to Billing</button>
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && <p style={{ fontSize: 13, color: "var(--text-gray)", margin: "8px 0" }}>Thinking…</p>}

        {pending && (
          <div style={{ border: "1px solid var(--warning-color)", background: "#fffbeb", borderRadius: 14, padding: 14, margin: "12px 0" }} role="group" aria-label="Confirm action">
            <p style={{ fontSize: 12, fontWeight: 700, color: "var(--warning-color)", marginBottom: 6 }}>CONFIRMATION NEEDED</p>
            <p style={{ fontSize: 14, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{pending.summary}</p>
            <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
              <button className="btn btn-primary" disabled={confirming || expired} onClick={confirm}>{confirming ? "Working…" : "Confirm"}</button>
              <button className="btn btn-ghost" disabled={confirming} onClick={cancel}>Cancel</button>
              {expired && <span style={{ fontSize: 12, color: "var(--text-gray)" }}>This confirmation expired — ask again.</span>}
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); send(input); }}
        style={{ display: "flex", gap: 8, marginTop: 12 }}
      >
        <input
          className="form-control"
          style={{ flex: 1 }}
          value={input}
          maxLength={MAX_MESSAGE_CHARS}
          placeholder="e.g. Which vendors haven't filed their GST?"
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
          aria-label="Ask the assistant"
        />
        <button className="btn btn-primary" type="submit" disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  );
}
