// Pure helpers for AssistantView — kept separate so they're unit-testable
// without rendering anything. Limits mirror backend-cloudflare/src/assistant/
// input.ts (LIMITS); the server re-validates, these just avoid sending a
// request that's certain to be rejected.
export const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_MESSAGE_CHARS = 2000;
const MAX_HISTORY_TOTAL_CHARS = 12000;

/**
 * Builds conversation_history from the visible transcript. Only real
 * user/assistant text goes back — never notices, errors or confirmation
 * cards, and never the confirmation token (a token must not be replayable
 * through the model).
 */
export function buildHistory(messages) {
  const turns = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && !m.kind && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_MESSAGE_CHARS) }));
  const recent = turns.slice(-MAX_HISTORY_MESSAGES);
  let total = 0;
  const kept = [];
  for (let i = recent.length - 1; i >= 0; i--) {   // keep the newest, drop the oldest, when over budget
    total += recent[i].content.length;
    if (total > MAX_HISTORY_TOTAL_CHARS) break;
    kept.unshift(recent[i]);
  }
  return kept;
}

/** Maps an { status, body } response to a user-facing notice. Never shows raw server text for 5xx. */
export function describeError({ status, body }) {
  const code = body?.error?.code;
  const msg = body?.error?.message;
  if (status === 0) return { text: "Couldn't reach the server. Check your connection and try again.", action: null };
  if (status === 402) return { text: "You're out of usage credits for this billing period, so the assistant can't run this.", action: "billing" };
  if (status === 429) return { text: "The assistant is busy right now. Please wait a moment and try again.", action: null };
  if (status === 501) return { text: msg || "This feature isn't available on this deployment.", action: null };
  if (status === 409) return { text: msg || "That action is no longer possible — things may have changed. Ask again.", action: null };
  if (status === 400) return { text: code === "VALIDATION_ERROR" && msg ? msg : "That request couldn't be processed.", action: null };
  return { text: "The assistant is temporarily unavailable. Please try again shortly.", action: null };
}

/** True once a confirm_action's token can no longer be redeemed (small clock-skew margin). */
export function isExpired(expiresAtSeconds, nowMs = Date.now()) {
  return typeof expiresAtSeconds !== "number" || nowMs / 1000 >= expiresAtSeconds - 5;
}

export const SUGGESTIONS = [
  "How much ITC is at risk right now?",
  "Which invoices have GST mismatches?",
  "Any open anomalies I should look at?",
];
