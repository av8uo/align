/**
 * Bedrock brain (AWS Builder mini challenge): Claude on Amazon Bedrock plays
 * the Alexa+ orchestrator — it reads the MCP tool catalog, decides which tools
 * to call, chains them, and phrases the spoken reply. The LLM never bypasses
 * the tools: all life data and all actions flow through the MCP server.
 *
 * Enable with env AWS credentials + LIFEOS_LLM=bedrock.
 * Model: BEDROCK_MODEL_ID (defaults to Claude Sonnet on Bedrock).
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import type { CallTool, OrchestratorReply, SessionState, ToolCallRecord } from "./orchestrator.js";
import { absorb } from "./orchestrator.js";

const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const MAX_TOOL_ROUNDS = 6;

const SYSTEM = `You are Alexa+, hosting the Align add-on — a proactive, cross-domain life-optimization agent.
Rules:
- Answer by CALLING TOOLS; never invent life data. All state lives behind the tools.
- Speak like a helpful voice assistant: short, warm, concrete. At most ~3 sentences unless reading a plan.
- Never execute apply_plan with approve=true unless the user's LAST message clearly consents (yes / do it / apply).
- If the briefing included a question and the user's message answers it, record it with check_in (pass question_id).
- Voice-only parity: never reference screens or buttons; read at most 5 items aloud.
- No technical jargon, tool names, IDs, or JSON in your spoken reply.`;

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export function toBedrockTools(tools: McpToolDef[]): Tool[] {
  return tools.map((t) => ({
    toolSpec: {
      name: t.name,
      // First sentence only — keeps each request's token footprint small so a
      // day-one Bedrock quota stretches across many more conversation turns.
      description: (t.description ?? t.name).split(/(?<=\.)\s+/)[0]!.slice(0, 180),
      inputSchema: { json: t.inputSchema as never },
    },
  }));
}

export function makeBedrockBrain(listTools: () => Promise<McpToolDef[]>) {
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION ?? "us-east-1" });

  return async function bedrockBrain(
    text: string,
    state: SessionState,
    callTool: CallTool,
  ): Promise<OrchestratorReply> {
    const tools = toBedrockTools(await listTools());
    const context =
      `Conversation anchors: lastQuestionId=${state.lastQuestionId ?? "none"}, ` +
      `lastInsightId=${state.lastInsightId ?? "none"}, lastPlanId=${state.lastPlanId ?? "none"}, ` +
      `planAwaitingApproval=${state.planAwaitingApproval}.`;

    const messages: Message[] = [
      ...state.history.slice(-8).map((h) => ({
        role: h.role === "user" ? ("user" as const) : ("assistant" as const),
        content: [{ text: h.text }],
      })),
      { role: "user" as const, content: [{ text: `${context}\n\nUser says: ${text}` }] },
    ];

    const toolCalls: ToolCallRecord[] = [];
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await client.send(
        new ConverseCommand({
          modelId: MODEL_ID,
          system: [{ text: SYSTEM }],
          messages,
          toolConfig: { tools },
          inferenceConfig: { maxTokens: 700, temperature: 0.4 },
        }),
      );
      const msg = res.output?.message;
      if (!msg) break;
      messages.push(msg);

      if (res.stopReason !== "tool_use") {
        const reply = (msg.content ?? [])
          .map((c) => c.text ?? "")
          .join(" ")
          .trim();
        return { reply: reply || "Sorry, I lost my train of thought — could you say that again?", toolCalls, brain: "bedrock" };
      }

      const resultBlocks = [];
      for (const block of msg.content ?? []) {
        if (!block.toolUse) continue;
        const call = await callTool(block.toolUse.name!, (block.toolUse.input ?? {}) as Record<string, unknown>);
        toolCalls.push(call);
        absorb(state, call);
        resultBlocks.push({
          toolResult: {
            toolUseId: block.toolUse.toolUseId!,
            content: [{ json: { text: call.text, data: call.data ?? {} } as never }],
            status: call.isError ? ("error" as const) : ("success" as const),
          },
        });
      }
      messages.push({ role: "user", content: resultBlocks });
    }
    return { reply: "That took more steps than I expected — here's where I got to.", toolCalls, brain: "bedrock" };
  };
}
