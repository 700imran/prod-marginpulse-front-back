// Thin client for the Anthropic Messages API with tool use — the same
// endpoint/headers pipelines/insights.ts already uses (works against
// Anthropic directly or an Anthropic-compatible gateway like OpenRouter;
// see the comment there on sending both auth headers).
import type { Env } from "../config";
import type { JsonSchema } from "./tools";

export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export type ModelBlock = TextBlock | ToolUseBlock;

export type ModelMessage =
  | { role: "user"; content: string | ToolResultBlock[] }
  | { role: "assistant"; content: string | ModelBlock[] };

export interface ModelToolDef {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export interface LlmRequest {
  system: string;
  messages: ModelMessage[];
  tools: ModelToolDef[];
  maxTokens: number;
}
export interface LlmResponse {
  content: ModelBlock[];
  stopReason: string | null;
}
export interface LlmClient {
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export function anthropicClient(env: Env): LlmClient {
  return {
    async complete(req) {
      const resp = await fetch(`${env.ANTHROPIC_API_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          Authorization: `Bearer ${env.ANTHROPIC_API_KEY}`,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: env.ANTHROPIC_MODEL,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: req.messages,
          tools: req.tools,
          tool_choice: { type: "auto" },
        }),
      });
      const out = (await resp.json()) as { content?: unknown[]; stop_reason?: string; error?: { message: string } };
      if (resp.status >= 400) throw new Error(out.error?.message ?? `HTTP ${resp.status}`);
      const blocks: ModelBlock[] = [];
      for (const b of out.content ?? []) {
        const blk = b as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
        if (blk.type === "text" && typeof blk.text === "string") blocks.push({ type: "text", text: blk.text });
        else if (blk.type === "tool_use" && typeof blk.id === "string" && typeof blk.name === "string") {
          const input = typeof blk.input === "object" && blk.input !== null && !Array.isArray(blk.input) ? (blk.input as Record<string, unknown>) : {};
          blocks.push({ type: "tool_use", id: blk.id, name: blk.name, input });
        }
      }
      return { content: blocks, stopReason: out.stop_reason ?? null };
    },
  };
}
