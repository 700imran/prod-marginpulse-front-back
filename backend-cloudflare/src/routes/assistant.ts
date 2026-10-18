// Natural-language assistant. Design and safety rationale:
// backend-cloudflare/WORKFLOW.md. Short version: the model only classifies
// and extracts arguments for a fixed tool list; the Worker runs the same
// authenticated, tenant-scoped, credit-metered code as the REST routes;
// anything that changes data needs a separate, signed, single-use
// confirmation request.
import { Hono } from "hono";
import type { Env } from "../config";
import type { Sql } from "../db";
import type { TenantContext } from "../auth/supabase";
import { requireAuth } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { apiError } from "../http";
import { AppError } from "../errors";
import { reserveForOperation } from "../billing/guard";
import { refundCredits } from "../billing/credits";
import { recordUsageEvent } from "../billing/usage";
import { checkAndIncrementAIBudget } from "../ratelimit";
import { reportError } from "../monitoring";
import { validateAssistantInput } from "../assistant/input";
import { runAssistant } from "../assistant/service";
import { anthropicClient } from "../assistant/llm";
import { activeTools, mutationsEnabled, MUTATING_TOOLS, ToolArgError } from "../assistant/tools";
import { signConfirmToken, verifyConfirmToken, consumeConfirmNonce } from "../assistant/confirm";
import { cleanString } from "../assistant/sanitize";

export const assistantRoutes = new Hono<{ Bindings: Env; Variables: { sql: Sql; tenant: TenantContext; requestId: string } }>();

assistantRoutes.use("*", requireAuth);

// Rough platform-wide cost estimate per assistant request, charged against
// the same daily AI budget as dashboard insights (ratelimit.ts). A guess,
// like the credit numbers in billing/pricing.ts — tune against real usage.
const ESTIMATED_COST_USD = 0.02;

// POST /assistant/message
assistantRoutes.post("/message", rateLimit("assistant", 20, 60), async (c) => {
  const tenant = c.get("tenant");
  const sql = c.get("sql");
  const requestId = c.get("requestId");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, 400, "VALIDATION_ERROR", "request body must be valid JSON");
  }
  let input;
  try {
    input = validateAssistantInput(body);
  } catch (e) {
    if (e instanceof AppError) return apiError(c, e.status, e.code, e.message);
    throw e;
  }

  if (!c.env.ANTHROPIC_API_KEY) return apiError(c, 501, "NOT_IMPLEMENTED", "the assistant isn't configured on this deployment");

  // Reserve one ASSISTANT_MESSAGE up front. Unlike the dashboard insight
  // there is no free fallback for an open-ended assistant, so insufficient
  // credits is a plain 402.
  const jobId = crypto.randomUUID();
  const reservation = await reserveForOperation(sql, tenant, "ASSISTANT_MESSAGE", jobId, requestId);
  if (!reservation.ok) {
    return apiError(c, 402, "INSUFFICIENT_CREDITS", "Not enough usage credits to use the assistant this billing period", { credits_remaining: reservation.balanceAfter });
  }
  const refund = async (why: string) => {
    await refundCredits(sql, { tenantId: tenant.tenantId, amount: reservation.amount, operation: "ASSISTANT_MESSAGE", jobId, correlationId: requestId, description: `Refund: ${why}` }).catch(() => {});
    await recordUsageEvent(sql, { tenantId: tenant.tenantId, provider: "ANTHROPIC", operation: "ASSISTANT_MESSAGE", outcome: "REFUNDED", creditsConsumed: -reservation.amount, correlationId: requestId, jobId }).catch(() => {});
  };

  // Platform-wide daily AI spend guard. Fails closed if Redis is down.
  let budgetOk = false;
  try {
    budgetOk = (await checkAndIncrementAIBudget(c.env, ESTIMATED_COST_USD)).allowed;
  } catch {
    budgetOk = false;
  }
  if (!budgetOk) {
    await refund("platform AI budget unavailable");
    return apiError(c, 429, "RATE_LIMITED", "the assistant is at capacity right now, please try again later");
  }

  try {
    const { reply, modelCalls } = await runAssistant({ env: c.env, sql, tenant }, input, {
      llm: anthropicClient(c.env),
      tools: activeTools(c.env),
      mutationsEnabled: mutationsEnabled(c.env),
      signConfirm: async (tenantId, action, args) => signConfirmToken(c.env, tenantId, action, args),
      maxTokens: Math.min(parseInt(c.env.LLM_MAX_TOKENS, 10) || 1024, parseInt(c.env.AI_MAX_COMPLETION_TOKENS, 10) || 2000),
    });
    await recordUsageEvent(sql, { tenantId: tenant.tenantId, provider: "ANTHROPIC", operation: "ASSISTANT_MESSAGE", outcome: "SUCCESS", creditsConsumed: reservation.amount, correlationId: requestId, jobId }).catch(() => {});
    console.log("assistant_message", { requestId, tenantId: tenant.tenantId, modelCalls, replyType: reply.type, action: reply.type === "confirm_action" ? reply.action : undefined });
    return c.json({ ...reply, credits_remaining: reservation.balanceAfter });
  } catch (e) {
    await refund("assistant request failed");
    c.executionCtx.waitUntil(reportError(c.env, e, { tags: { area: "assistant", requestId } }));
    return apiError(c, 502, "UPSTREAM_ERROR", "the assistant is temporarily unavailable");
  }
});

// POST /assistant/confirm   body: { confirmation_token }
// The only way an assistant-proposed action runs. Not model-driven: this
// is the user pressing a button the app rendered from a confirm_action.
assistantRoutes.post("/confirm", rateLimit("assistant_confirm", 10, 60), async (c) => {
  if (!mutationsEnabled(c.env)) return apiError(c, 501, "NOT_IMPLEMENTED", "assistant actions are not enabled on this deployment");
  const tenant = c.get("tenant");
  const sql = c.get("sql");

  let token: unknown;
  try {
    token = ((await c.req.json()) as { confirmation_token?: unknown }).confirmation_token;
  } catch {
    return apiError(c, 400, "VALIDATION_ERROR", "request body must be valid JSON");
  }
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) return apiError(c, 400, "VALIDATION_ERROR", "confirmation_token is required");

  const verified = await verifyConfirmToken(c.env, token, tenant.tenantId);
  if (!verified.ok) {
    // WRONG_TENANT and BAD_SIGNATURE deliberately look the same as any other bad token to the caller.
    console.warn("assistant_confirm_rejected", { tenantId: tenant.tenantId, reason: verified.reason });
    return apiError(c, 400, "VALIDATION_ERROR", verified.reason === "EXPIRED" ? "this confirmation has expired — ask again" : "invalid confirmation");
  }
  const { act, args, nonce } = verified.payload;

  const tool = MUTATING_TOOLS.find((t) => t.name === act);
  if (!tool) return apiError(c, 400, "VALIDATION_ERROR", "invalid confirmation");

  // Spend the token first, fail closed: if Redis is unreachable we cannot
  // record that it was used, so we don't run a data-changing action.
  let fresh: boolean;
  try {
    fresh = await consumeConfirmNonce(c.env, nonce);
  } catch {
    return apiError(c, 503, "UPSTREAM_ERROR", "couldn't verify this confirmation right now, please try again");
  }
  if (!fresh) return apiError(c, 409, "CONFLICT", "this confirmation was already used");

  const ctx = { env: c.env, sql, tenant };
  // Re-validate against *current* state — the document may have changed
  // since the proposal was made.
  let prepared;
  try {
    prepared = await tool.prepare(ctx, args);
  } catch (e) {
    return apiError(c, 400, "VALIDATION_ERROR", e instanceof ToolArgError ? cleanString(e.message, 200) : "invalid confirmation");
  }
  if (!prepared.ok) return apiError(c, 409, "CONFLICT", prepared.message);

  const result = await tool.execute(ctx, prepared.args);
  console.log("assistant_action", { requestId: c.get("requestId"), tenantId: tenant.tenantId, action: act, ok: result.ok });
  if (!result.ok) {
    const status = result.code === "INSUFFICIENT_CREDITS" ? 402 : result.code === "NOT_FOUND" ? 404 : 400;
    return apiError(c, status, result.code, result.message, result.details);
  }
  return c.json({ type: "action_result", action: act, message: result.message, ...(result.data ? { data: result.data } : {}) });
});
