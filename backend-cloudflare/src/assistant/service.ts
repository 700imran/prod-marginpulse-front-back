// The orchestration loop: model <-> tools, with the safety boundary from
// WORKFLOW.md enforced HERE, in code, independent of what the model says:
//
//   * Only tools in the registry slice passed in can run. A tool name the
//     model invents ("delete_account") is rejected, never mapped to a
//     "nearby" tool.
//   * Read tools run immediately; their output is sanitized and wrapped as
//     untrusted data before the model sees it.
//   * A mutating tool NEVER runs from here. It is only `prepare`d (validated
//     against current DB state, summary written by us), and the loop ends
//     by returning a confirm_action carrying a signed token. Execution is a
//     separate request (POST /assistant/confirm).
//   * Tool arguments are validated by the tool, never trusted from the model.
import type { ChatMessage } from "./input";
import type { LlmClient, ModelMessage, ModelToolDef, ToolResultBlock, ToolUseBlock } from "./llm";
import type { AssistantTool, ToolContext } from "./tools";
import { ToolArgError } from "./tools";
import { toSafeJson, wrapUntrusted, cleanModelText, cleanString } from "./sanitize";
import { buildSystemPrompt } from "./prompt";

export const MAX_MODEL_ROUNDS = 4;

export type AssistantReply =
  | { type: "text"; message: string }
  | { type: "confirm_action"; action: string; args: Record<string, unknown>; summary: string; confirmation_token: string; expires_at: number };

export interface RunDeps {
  llm: LlmClient;
  tools: AssistantTool[];
  mutationsEnabled: boolean;
  signConfirm(tenantId: string, action: string, args: Record<string, unknown>): Promise<{ token: string; exp: number }>;
  maxTokens: number;
}

export interface RunResult {
  reply: AssistantReply;
  modelCalls: number;
}

export async function runAssistant(ctx: ToolContext, input: { message: string; history: ChatMessage[] }, deps: RunDeps): Promise<RunResult> {
  const byName = new Map(deps.tools.map((t) => [t.name, t]));
  const toolDefs: ModelToolDef[] = deps.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const system = buildSystemPrompt(deps.mutationsEnabled);

  const messages: ModelMessage[] = [...input.history.map((m) => ({ role: m.role, content: m.content }) as ModelMessage), { role: "user", content: input.message }];
  let modelCalls = 0;

  for (let round = 0; round < MAX_MODEL_ROUNDS; round++) {
    const resp = await deps.llm.complete({ system, messages, tools: toolDefs, maxTokens: deps.maxTokens });
    modelCalls++;

    const toolUses = resp.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    const text = resp.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    if (toolUses.length === 0) {
      return { reply: { type: "text", message: cleanModelText(text) || "Sorry, I couldn't put together an answer. Could you rephrase?" }, modelCalls };
    }

    const results: ToolResultBlock[] = [];

    // A mutating tool call ends the loop with a proposal: the first valid
    // one wins; any others in the same turn are dropped.
    for (const use of toolUses) {
      const tool = byName.get(use.name);
      if (tool?.kind !== "mutating") continue;
      try {
        const prepared = await tool.prepare(ctx, use.input);
        if (prepared.ok) {
          const { token, exp } = await deps.signConfirm(ctx.tenant.tenantId, tool.name, prepared.args);
          return {
            reply: { type: "confirm_action", action: tool.name, args: prepared.args, summary: cleanString(prepared.summary, 400), confirmation_token: token, expires_at: exp },
            modelCalls,
          };
        }
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: cleanString(prepared.message, 300) });
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: e instanceof ToolArgError ? cleanString(e.message, 300) : "That action couldn't be prepared." });
      }
    }

    for (const use of toolUses) {
      if (results.some((r) => r.tool_use_id === use.id)) continue; // already answered above
      const tool = byName.get(use.name);
      if (!tool) {
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: "Unknown tool. That capability isn't available." });
        continue;
      }
      if (tool.kind === "mutating") {
        // A second mutating call after a failed first one is skipped, not executed.
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: "Only one action can be proposed per reply." });
        continue;
      }
      try {
        const data = await tool.run(ctx, use.input);
        results.push({ type: "tool_result", tool_use_id: use.id, content: wrapUntrusted(tool.name, toSafeJson(data)) });
      } catch (e) {
        if (!(e instanceof ToolArgError)) console.error("assistant_tool_error", { tool: tool.name, message: e instanceof Error ? e.message : String(e) });
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: e instanceof ToolArgError ? cleanString(e.message, 300) : "That lookup failed." });
      }
    }

    messages.push({ role: "assistant", content: resp.content });
    messages.push({ role: "user", content: results });
  }

  return { reply: { type: "text", message: "I wasn't able to finish that. Could you ask a more specific question?" }, modelCalls };
}
