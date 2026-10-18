// Validation of the request body for POST /assistant/message. The client
// supplies `conversation_history` itself (the Worker is stateless for
// Phase 1), so it is untrusted input: bounded in count and size, restricted
// to plain user/assistant text — a client can never inject a `system`
// message, a forged tool_use, or a forged tool_result — and normalized into
// the strictly alternating user/assistant sequence the model API requires.
import { AppError } from "../errors";

export const LIMITS = {
  message: 2000,
  historyMessages: 20,
  historyMessageChars: 2000,
  historyTotalChars: 12000,
} as const;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantInput {
  message: string;
  history: ChatMessage[];
}

const bad = (msg: string) => new AppError("VALIDATION_ERROR", 400, msg);

export function validateAssistantInput(body: unknown): AssistantInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw bad("request body must be a JSON object");
  const { message, conversation_history: rawHistory } = body as { message?: unknown; conversation_history?: unknown };

  if (typeof message !== "string" || message.trim().length === 0) throw bad("message is required");
  if (message.length > LIMITS.message) throw bad(`message exceeds ${LIMITS.message} characters`);

  let history: ChatMessage[] = [];
  if (rawHistory !== undefined && rawHistory !== null) {
    if (!Array.isArray(rawHistory)) throw bad("conversation_history must be an array");
    if (rawHistory.length > LIMITS.historyMessages) throw bad(`conversation_history exceeds ${LIMITS.historyMessages} messages`);
    let total = 0;
    for (const item of rawHistory) {
      if (typeof item !== "object" || item === null) throw bad("conversation_history entries must be objects");
      const { role, content } = item as { role?: unknown; content?: unknown };
      if (role !== "user" && role !== "assistant") throw bad('conversation_history roles must be "user" or "assistant"');
      if (typeof content !== "string") throw bad("conversation_history content must be a string");
      if (content.length > LIMITS.historyMessageChars) throw bad(`a conversation_history message exceeds ${LIMITS.historyMessageChars} characters`);
      total += content.length;
      if (content.trim().length > 0) history.push({ role, content });
    }
    if (total > LIMITS.historyTotalChars) throw bad(`conversation_history exceeds ${LIMITS.historyTotalChars} characters in total`);
  }

  return { message: message.trim(), history: normalizeAlternation(history, message.trim()) };
}

// The model API requires the conversation to start with a user turn and
// alternate roles. Merge consecutive same-role turns, drop a leading
// assistant turn, and make sure it ends on an assistant turn so the new
// user message can be appended.
function normalizeAlternation(history: ChatMessage[], _latest: string): ChatMessage[] {
  const merged: ChatMessage[] = [];
  for (const m of history) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n${m.content}`;
    else merged.push({ ...m });
  }
  while (merged[0]?.role === "assistant") merged.shift();
  if (merged[merged.length - 1]?.role === "user") merged.pop(); // the new message takes its place
  return merged;
}
