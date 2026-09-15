// Exact port of internal/pipelines/insights/insights.go. Same
// rule-based fallback, same prompt, same budget-check-before-call flow.
import type { Env } from "../config";
import { checkAndIncrementAIBudget } from "../ratelimit";

const SYSTEM_PROMPT = `You are a plain-English financial summariser for small business owners.
Your job is to convert raw reconciliation data into a single, clear, jargon-free paragraph
(2-4 sentences max) that a non-accountant can understand immediately.

Rules:
- Never use accounting jargon (ledger, debit, credit, reconciliation, etc.)
- Always mention specific vendor names and rupee amounts where available
- If GST credits are at risk, state the exact INR amount blocked
- Be direct and actionable — end with what the owner should do next
- Keep under 80 words total
- Output ONLY the summary paragraph, no preamble or formatting`;

export interface SummaryData {
  totalUploadedDocuments: number;
  successfullyReconciledCount: number;
  unreconciledAnomaliesDetected: number;
  gstMismatchFlagCount: number;
  itcAtRisk: number;
  gstProblemVendors: string[];
  anomalyBreakdown: Record<string, number>;
  period: string;
}

export async function generateInsight(env: Env, data: SummaryData, tenantId: string): Promise<string> {
  if (!env.ANTHROPIC_API_KEY) return ruleBasedInsight(data);

  if (tenantId) {
    // ~$0.01 per call is a rough estimate for an 80-word completion on a
    // small prompt — config.go didn't hardcode a per-call cost either,
    // it just gated on token/request counters; adjust if you want a
    // tighter estimate once you see real Anthropic usage costs.
    const { allowed } = await checkAndIncrementAIBudget(env, 0.01);
    if (!allowed) return ruleBasedInsight(data);
  }

  const period = data.period || "current period";
  const userMessage = `Here is the reconciliation data for this period:

Total documents processed: ${data.totalUploadedDocuments}
Successfully matched: ${data.successfullyReconciledCount}
Unresolved anomalies: ${data.unreconciledAnomaliesDetected}
GST portal mismatches: ${data.gstMismatchFlagCount}
ITC amount at risk (INR): ${data.itcAtRisk.toFixed(2)}
Vendors with GST issues: ${JSON.stringify(data.gstProblemVendors)}
Anomaly types: ${JSON.stringify(data.anomalyBreakdown)}
Period: ${period}

Write the plain-English summary.`;

  const maxPromptChars = parseInt(env.AI_MAX_PROMPT_TOKENS, 10) * 4;
  const trimmedMessage = userMessage.length > maxPromptChars ? userMessage.slice(0, maxPromptChars) : userMessage;
  const maxTokens = Math.min(parseInt(env.LLM_MAX_TOKENS, 10), parseInt(env.AI_MAX_COMPLETION_TOKENS, 10));

  try {
    return await callAnthropic(env, trimmedMessage, maxTokens);
  } catch {
    return ruleBasedInsight(data);
  }
}

async function callAnthropic(env: Env, userMessage: string, maxTokens: number): Promise<string> {
  const resp = await fetch(`${env.ANTHROPIC_API_BASE_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Sent alongside each other on purpose: Anthropic's own API reads
      // x-api-key (and ignores the unused Authorization header);
      // OpenRouter's Anthropic-compatible endpoint
      // (https://openrouter.ai/api/v1/messages) requires Authorization:
      // Bearer instead. This lets ANTHROPIC_API_BASE_URL/ANTHROPIC_API_KEY
      // point at either provider with no other code change — for
      // OpenRouter, set ANTHROPIC_API_BASE_URL="https://openrouter.ai/api"
      // and ANTHROPIC_MODEL to OpenRouter's provider-prefixed model name
      // (e.g. "anthropic/claude-sonnet-4.5"), not Anthropic's native one.
      "x-api-key": env.ANTHROPIC_API_KEY,
      "Authorization": `Bearer ${env.ANTHROPIC_API_KEY}`,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  const out = (await resp.json()) as { content?: { text: string }[]; error?: { message: string } };
  if (resp.status >= 400) throw new Error(out.error?.message ?? `HTTP ${resp.status}`);
  if (!out.content || out.content.length === 0) throw new Error("anthropic API returned no content");
  return out.content[0]!.text.trim();
}

// Exact port of ruleBasedInsight — same three branches, same thresholds.
function ruleBasedInsight(data: SummaryData): string {
  const { totalUploadedDocuments: total, successfullyReconciledCount: matched, unreconciledAnomaliesDetected: anomalies, gstMismatchFlagCount: gstGaps, itcAtRisk: itcRisk, gstProblemVendors: vendors } = data;
  const matchPct = total > 0 ? Math.round((matched / total) * 100) : 0;
  const vendorStr = vendors.length > 0 ? vendors.slice(0, 2).join(" and ") : "some vendors";

  if (gstGaps > 0) {
    const entryWord = gstGaps === 1 ? "entry" : "entries";
    const haveWord = vendors.length === 1 ? "hasn't" : "haven't";
    const invoiceWord = vendors.length === 1 ? "their invoice" : "their invoices";
    return `Your cash flow is matching cleanly at ${matchPct}% (${matched} of ${total} documents), except for ${gstGaps} supplier ${entryWord}. ${vendorStr} ${haveWord} filed ${invoiceWord} on the GST Portal yet, blocking ₹${formatINR(itcRisk)} in Input Tax Credits. Send them a reminder to file immediately.`;
  }
  if (anomalies > 0) {
    return `Good news — ${matchPct}% of your transactions matched automatically this period. There are ${anomalies} items that need your review, likely due to amount variances or timing differences with your bank. Check the flagged rows to clear them.`;
  }
  return `Everything is clean — all ${total} transactions matched perfectly this period. No GST issues or payment anomalies detected. You're all set.`;
}

function formatINR(amount: number): string {
  const whole = Math.round(amount);
  return whole.toLocaleString("en-IN");
}

function formatINRDecimal(amount: number): string {
  const whole = formatINR(amount);
  const cents = Math.abs(Math.round(amount * 100)) % 100;
  return `${whole}.${String(cents).padStart(2, "0")}`;
}

// Exact port of GenerateCollectionScript — same three templates.
export function generateCollectionScript(vendorName: string, invoiceNumber: string, amount: number, invoiceDate: string, issueType: string): string {
  const amountStr = formatINRDecimal(amount);
  switch (issueType) {
    case "GST_PORTAL_MISMATCH":
    case "":
      return `Hi ${vendorName} team,\n\nI wanted to follow up regarding invoice ${invoiceNumber} dated ${invoiceDate} for ₹${amountStr}. This invoice has not yet appeared on our GSTR-2B portal for the current period, which is currently blocking our Input Tax Credit claim.\n\nCould you please file this at the earliest convenience? This will help both of us close our GST reconciliation on time.\n\nThank you for your prompt attention.`;
    case "OVERDUE_PAYMENT":
      return `Hi ${vendorName} team,\n\nThis is a gentle reminder that invoice ${invoiceNumber} for ₹${amountStr} issued on ${invoiceDate} appears to be outstanding in our records.\n\nPlease let us know if you have any questions or if payment has already been arranged. You can settle via the payment link attached.\n\nThank you.`;
    default:
      return `Hi ${vendorName} team,\n\nWe noticed a discrepancy in invoice ${invoiceNumber} (₹${amountStr}, ${invoiceDate}). Could you please review and confirm the details? We'd like to reconcile this promptly.\n\nThank you.`;
  }
}
