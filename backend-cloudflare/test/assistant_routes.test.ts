// HTTP-level tests for /api/v1/assistant/*: the real Hono routes, the real
// orchestration and token code; only auth, Postgres-touching modules,
// Redis and the model API are replaced.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const DOC_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const state = vi.hoisted(() => ({
  tenantId: "11111111-1111-1111-1111-111111111111",
  redis: new Map<string, string>(),
  redisDown: false,
  budgetAllowed: true,
  balance: 100,
  llmScript: [] as unknown[][],
  llmThrows: false,
  doc: null as Record<string, unknown> | null,
}));

vi.mock("../src/middleware/auth", () => ({
  requireAuth: async (c: any, next: any) => {
    c.set("tenant", { tenantId: state.tenantId, ownerEmail: "o@x.in", businessName: "X", planTier: "GROWTH", isActive: true, isPlatformAdmin: false, gstinNumber: "27AAAAA0000A1Z5", deletionRequestedAt: null });
    c.set("sql", {});
    await next();
  },
}));
vi.mock("../src/ratelimit", () => ({
  checkRateLimit: async () => ({ allowed: true, remaining: 9 }),
  checkAndIncrementAIBudget: async () => { if (state.redisDown) throw new Error("redis down"); return { allowed: state.budgetAllowed, spentTodayUSD: 0 }; },
  upstash: async (_e: unknown, ...cmd: (string | number)[]) => {
    if (state.redisDown) throw new Error("redis down");
    const key = String(cmd[1]);
    if (state.redis.has(key)) return null;
    state.redis.set(key, "1");
    return "OK";
  },
}));
const reserve = vi.hoisted(() => vi.fn());
const refund = vi.hoisted(() => vi.fn());
const usage = vi.hoisted(() => vi.fn());
vi.mock("../src/billing/guard", () => ({ reserveForOperation: reserve }));
vi.mock("../src/billing/credits", () => ({ refundCredits: refund }));
vi.mock("../src/billing/usage", () => ({ recordUsageEvent: usage }));
vi.mock("../src/monitoring", () => ({ reportError: async () => {} }));
vi.mock("../src/assistant/llm", () => ({
  anthropicClient: () => ({
    async complete() {
      if (state.llmThrows) throw new Error("upstream 500");
      return { content: state.llmScript.shift() ?? [{ type: "text", text: "done" }], stopReason: "end_turn" };
    },
  }),
}));
const requestGstSync = vi.hoisted(() => vi.fn());
const trashDocument = vi.hoisted(() => vi.fn());
vi.mock("../src/actions/gst", () => ({ requestGstSync }));
vi.mock("../src/actions/documents", () => ({ trashDocument, untrashDocument: vi.fn() }));
vi.mock("../src/repository/documents", () => ({
  getDocumentById: async () => state.doc,
  listByGSTStatus: async () => [], searchDocumentsByInvoiceOrVendor: async () => [],
}));
vi.mock("../src/repository/anomalies", () => ({ listAnomalies: async () => [] }));
vi.mock("../src/pipelines/dashboard", () => ({ buildDashboardSummary: async () => ({ summaryMetrics: {}, itcAtRisk: 0, gstProblemVendors: [] }) }));

import { assistantRoutes } from "../src/routes/assistant";

const ENV = (over: Record<string, string> = {}) => ({
  ENVIRONMENT: "test", ANTHROPIC_API_KEY: "k", ANTHROPIC_API_BASE_URL: "https://x", ANTHROPIC_MODEL: "m",
  LLM_MAX_TOKENS: "1024", AI_MAX_COMPLETION_TOKENS: "2000", FIELD_ENCRYPTION_KEY: "route-test-key-0123456789",
  ASSISTANT_MUTATIONS_ENABLED: "true", ...over,
});

function call(path: string, body: unknown, env = ENV()) {
  const app = new Hono<any>();
  app.use("*", async (c, next) => { c.set("requestId", "req-1"); await next(); });
  app.route("/api/v1/assistant", assistantRoutes);
  return app.request(`/api/v1/assistant${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env, { waitUntil() {}, passThroughOnException() {} } as any);
}
const json = async (r: Response) => (await r.json()) as any;

beforeEach(() => {
  state.tenantId = TENANT_A; state.redis.clear(); state.redisDown = false; state.budgetAllowed = true;
  state.llmScript = []; state.llmThrows = false;
  state.doc = { documentId: DOC_ID, vendorName: "Acme", invoiceNumber: "INV-1", originalFilename: "a.pdf", deletedAt: null };
  reserve.mockReset().mockResolvedValue({ ok: true, balanceAfter: 99, amount: 1 });
  refund.mockReset().mockResolvedValue({ ok: true, balanceAfter: 100 });
  usage.mockReset().mockResolvedValue(undefined);
  requestGstSync.mockReset().mockResolvedValue({ ok: true, jobId: "j1", gstin: "g", creditsReserved: 5, creditsRemaining: 90 });
  trashDocument.mockReset().mockResolvedValue({});
  vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /assistant/message", () => {
  it("reserves ASSISTANT_MESSAGE exactly once per request, however many model rounds", async () => {
    state.llmScript = [[{ type: "tool_use", id: "t1", name: "get_dashboard_summary", input: {} }], [{ type: "text", text: "All clear." }]];
    const r = await call("/message", { message: "how are we doing?" });
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ type: "text", message: "All clear.", credits_remaining: 99 });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve.mock.calls[0]![2]).toBe("ASSISTANT_MESSAGE");
    expect(refund).not.toHaveBeenCalled();
  });

  it("402 with no model call when out of credits", async () => {
    reserve.mockResolvedValue({ ok: false, balanceAfter: 0, amount: 1 });
    const r = await call("/message", { message: "hi" });
    expect(r.status).toBe(402);
    expect((await json(r)).error).toMatchObject({ code: "INSUFFICIENT_CREDITS", details: { credits_remaining: 0 } });
  });

  it("501 and no charge when the assistant isn't configured", async () => {
    const r = await call("/message", { message: "hi" }, ENV({ ANTHROPIC_API_KEY: "" }));
    expect(r.status).toBe(501);
    expect(reserve).not.toHaveBeenCalled();
  });

  it("refunds and returns 502 when the model fails", async () => {
    state.llmThrows = true;
    const r = await call("/message", { message: "hi" });
    expect(r.status).toBe(502);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund.mock.calls[0]![1]).toMatchObject({ amount: 1, operation: "ASSISTANT_MESSAGE" });
  });

  it("refunds and returns 429 when the platform AI budget is exhausted or Redis is down (fails closed)", async () => {
    state.budgetAllowed = false;
    expect((await call("/message", { message: "hi" })).status).toBe(429);
    state.budgetAllowed = true; state.redisDown = true;
    expect((await call("/message", { message: "hi" })).status).toBe(429);
    expect(refund).toHaveBeenCalledTimes(2);
  });

  it("400 for invalid bodies, before any credit is reserved", async () => {
    for (const body of [{}, { message: "" }, { message: "x", conversation_history: [{ role: "system", content: "x" }] }]) {
      expect((await call("/message", body)).status).toBe(400);
    }
    expect(reserve).not.toHaveBeenCalled();
  });

  it("returns confirm_action for a mutation and charges only the message, not the action", async () => {
    state.llmScript = [[{ type: "tool_use", id: "t1", name: "sync_gst", input: { period: "072026" } }]];
    const r = await call("/message", { message: "sync gst for july" });
    const b = await json(r);
    expect(b).toMatchObject({ type: "confirm_action", action: "sync_gst", args: { period: "072026" } });
    expect(typeof b.confirmation_token).toBe("string");
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(requestGstSync).not.toHaveBeenCalled();
  });

  it("never offers mutations while the flag is off", async () => {
    state.llmScript = [[{ type: "tool_use", id: "t1", name: "soft_delete_document", input: { document_id: DOC_ID } }], [{ type: "text", text: "Read-only here." }]];
    const r = await call("/message", { message: "delete it" }, ENV({ ASSISTANT_MUTATIONS_ENABLED: "false" }));
    expect((await json(r)).type).toBe("text");
    expect(trashDocument).not.toHaveBeenCalled();
  });
});

describe("POST /assistant/confirm", () => {
  async function propose(name: string, input: Record<string, unknown>) {
    state.llmScript = [[{ type: "tool_use", id: "t1", name, input }]];
    return (await json(await call("/message", { message: "do it" }))).confirmation_token as string;
  }

  it("runs the action once with a valid token; a replay is refused", async () => {
    const token = await propose("sync_gst", { period: "072026" });
    reserve.mockClear();
    const r1 = await call("/confirm", { confirmation_token: token });
    expect(r1.status).toBe(200);
    expect(await json(r1)).toMatchObject({ type: "action_result", action: "sync_gst" });
    expect(requestGstSync).toHaveBeenCalledTimes(1);
    expect(requestGstSync.mock.calls[0]![3]).toBe("072026");
    expect(reserve).not.toHaveBeenCalled(); // no second ASSISTANT_MESSAGE charge; the action's own reservation lives in requestGstSync

    const r2 = await call("/confirm", { confirmation_token: token });
    expect(r2.status).toBe(409);
    expect(requestGstSync).toHaveBeenCalledTimes(1);
  });

  it("refuses another tenant's token", async () => {
    const token = await propose("soft_delete_document", { document_id: DOC_ID });
    state.tenantId = TENANT_B;
    const r = await call("/confirm", { confirmation_token: token });
    expect(r.status).toBe(400);
    expect(trashDocument).not.toHaveBeenCalled();
  });

  it("refuses tampered, empty and garbage tokens", async () => {
    const token = await propose("soft_delete_document", { document_id: DOC_ID });
    const tampered = token.slice(0, -3) + (token.endsWith("AAA") ? "BBB" : "AAA");
    for (const t of [tampered, "", "garbage", 42]) expect((await call("/confirm", { confirmation_token: t })).status).toBe(400);
    expect(trashDocument).not.toHaveBeenCalled();
  });

  it("re-validates current state: a document trashed since the proposal is a 409, nothing executes", async () => {
    const token = await propose("soft_delete_document", { document_id: DOC_ID });
    state.doc = { ...state.doc!, deletedAt: "2026-10-18" };
    const r = await call("/confirm", { confirmation_token: token });
    expect(r.status).toBe(409);
    expect(trashDocument).not.toHaveBeenCalled();
  });

  it("executes soft delete with an assistant-tagged audit reason", async () => {
    const token = await propose("soft_delete_document", { document_id: DOC_ID });
    expect((await call("/confirm", { confirmation_token: token })).status).toBe(200);
    expect(trashDocument.mock.calls[0]![3]).toBe("via assistant: soft_delete_document");
  });

  it("surfaces INSUFFICIENT_CREDITS from the action as 402", async () => {
    const token = await propose("sync_gst", {});
    requestGstSync.mockResolvedValue({ ok: false, reason: "INSUFFICIENT_CREDITS", creditsRemaining: 2 });
    const r = await call("/confirm", { confirmation_token: token });
    expect(r.status).toBe(402);
    expect((await json(r)).error.details).toEqual({ credits_remaining: 2 });
  });

  it("fails closed when Redis is down: the action does not run", async () => {
    const token = await propose("sync_gst", {});
    state.redisDown = true;
    const r = await call("/confirm", { confirmation_token: token });
    expect(r.status).toBe(503);
    expect(requestGstSync).not.toHaveBeenCalled();
  });

  it("501 while the flag is off, even with a validly signed token", async () => {
    const token = await propose("sync_gst", {});
    const r = await call("/confirm", { confirmation_token: token }, ENV({ ASSISTANT_MUTATIONS_ENABLED: "false" }));
    expect(r.status).toBe(501);
    expect(requestGstSync).not.toHaveBeenCalled();
  });
});
