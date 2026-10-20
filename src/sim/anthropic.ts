/**
 * Claude-API brain: the same host role as the Bedrock brain (an LLM playing
 * Alexa+ — reads the MCP tool catalog, chains tool calls, phrases the spoken
 * reply), reached through the Claude API directly instead of Amazon Bedrock.
 *
 * Why it exists: the Bedrock path is implemented and tested, but a new AWS
 * account's daily token quota throttles every call. This path lets the
 * simulator hold a real conversation without AWS. Enable with
 * ANTHROPIC_API_KEY + LIFEOS_LLM=anthropic. The LLM never bypasses the tools.
 */
import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM, type McpToolDef } from "./bedrock.js";
import type { CallTool, OrchestratorReply, SessionState, ToolCallRecord } from "./orchestrator.js";
import { absorb } from "./orchestrator.js";

export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";
const MAX_TOOL_ROUNDS = 6;

export function toAnthropicTools(tools: McpToolDef[]): Anthropic.Tool[] {
  return tools.map((t) => {
    const { $schema: _drop, ...schema } = t.inputSchema;
    return {
      name: t.name,
      // Full description here: the Claude API has no day-one token quota to protect.
      description: t.description ?? t.name,
      input_schema: schema as Anthropic.Tool.InputSchema,
    };
  });
}

export interface AnthropicBrainOptions {
  /** Injectable transport (tests); defaults to a real Anthropic client. */
  create?: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
  log?: (s: string) => void;
}

export type AnthropicBrain = ((text: string, state: SessionState, callTool: CallTool) => Promise<OrchestratorReply>) & {
  status: () => { provider: "anthropic"; model: string; configured: boolean };
};

export function makeAnthropicBrain(listTools: () => Promise<McpToolDef[]>, opts: AnthropicBrainOptions = {}): AnthropicBrain {
  const configured = Boolean(opts.create || process.env.ANTHROPIC_API_KEY);
  const log = opts.log ?? ((s: string) => console.warn(s));
  const create =
    opts.create ??
    (() => {
      const client = new Anthropic();
      return (params: Anthropic.MessageCreateParamsNonStreaming) => client.messages.create(params);
    })();

  let toolsCache: Anthropic.Tool[] | null = null;
  const tools = async () => (toolsCache ??= toAnthropicTools(await listTools()));

  const brain = async function anthropicBrain(text: string, state: SessionState, callTool: CallTool): Promise<OrchestratorReply> {
    if (!configured) throw new Error("ANTHROPIC_API_KEY is not set");
    const context =
      `Conversation anchors: lastQuestionId=${state.lastQuestionId ?? "none"}, ` +
      `lastInsightId=${state.lastInsightId ?? "none"}, lastPlanId=${state.lastPlanId ?? "none"}, ` +
      `planAwaitingApproval=${state.planAwaitingApproval}.`;

    const messages: Anthropic.MessageParam[] = [
      ...state.history.slice(-8).map((h) => ({ role: h.role, content: h.text })),
      { role: "user", content: `${context}\n\nUser says: ${text}` },
    ];

    const toolCalls: ToolCallRecord[] = [];
    let inTok = 0;
    let outTok = 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let res: Anthropic.Message;
      try {
        res = await create({
          model: ANTHROPIC_MODEL,
          max_tokens: 2048,
          system: SYSTEM,
          tools: await tools(),
          messages,
          // A voice assistant turn is short and latency-sensitive: low effort.
          output_config: { effort: "low" },
        });
      } catch (e) {
        const err = e as { name?: string; status?: number; message?: string };
        log(`claude api failed (${err.name ?? "Error"}${err.status ? ` ${err.status}` : ""}): ${err.message}`);
        // Tools already ran: their effects are real — finish from their words
        // rather than letting the fallback execute them a second time.
        if (toolCalls.length > 0) return { reply: toolCalls.map((c) => c.text).filter(Boolean).join(" "), toolCalls, brain: "anthropic" };
        throw e;
      }
      inTok += res.usage.input_tokens;
      outTok += res.usage.output_tokens;
      messages.push({ role: "assistant", content: res.content });

      if (res.stop_reason === "refusal") {
        log(`claude api refused the turn (${res.stop_details?.category ?? "no category"})`);
        throw new Error("model declined the turn");
      }
      if (res.stop_reason !== "tool_use") {
        log(`claude api turn: ${round + 1} call(s), ${toolCalls.length} tool(s), tokens in=${inTok} out=${outTok}`);
        const reply = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join(" ")
          .trim();
        return { reply: reply || "Sorry, I lost my train of thought — could you say that again?", toolCalls, brain: "anthropic" };
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type !== "tool_use") continue;
        const call = await callTool(block.name, (block.input ?? {}) as Record<string, unknown>);
        toolCalls.push(call);
        absorb(state, call);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify({ text: call.text, data: call.data ?? {} }),
          is_error: call.isError,
        });
      }
      messages.push({ role: "user", content: results });
    }
    log(`claude api turn hit MAX_TOOL_ROUNDS, tokens in=${inTok} out=${outTok}`);
    return { reply: "That took more steps than I expected — here's where I got to.", toolCalls, brain: "anthropic" };
  } as AnthropicBrain;

  brain.status = () => ({ provider: "anthropic", model: ANTHROPIC_MODEL, configured });
  return brain;
}
