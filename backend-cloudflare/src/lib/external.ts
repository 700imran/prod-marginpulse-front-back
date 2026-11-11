// Every call to a third party (GST portal, bank-verification API, LLM, Razorpay, Stripe, Slack, Resend, WhatsApp)
// goes through here. A bare fetch() has NO timeout: one hung provider connection pins the request (or queue
// message) until the platform kills it minutes later — the root cause of "the button spins forever" and of the
// verification queue wedging. Now each call has a hard deadline and a typed failure.
export type ExternalKind = "timeout" | "network";

export class ExternalCallError extends Error {
  constructor(public provider: string, public kind: ExternalKind, message: string) { super(message); this.name = "ExternalCallError"; }
}

export const EXTERNAL_TIMEOUTS = { gst: 15_000, bank: 15_000, llm: 45_000, payments: 12_000, chat: 8_000, email: 10_000, media: 20_000, default: 10_000 } as const;

// Statuses worth retrying later: the provider is slow, throttling or failing — not rejecting our request.
export const isRetryableStatus = (s: number) => s === 408 || s === 425 || s === 429 || s >= 500;

export async function fetchExternal(provider: string, url: string, init: RequestInit = {}, timeoutMs: number = EXTERNAL_TIMEOUTS.default): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const err = e as Error;
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    throw new ExternalCallError(provider, timedOut ? "timeout" : "network", timedOut ? `${provider} did not respond within ${Math.round(timeoutMs / 1000)}s` : `${provider} request failed: ${err.message}`);
  }
}
