/**
 * Bedrock brain (AWS Builder mini challenge): Claude on Amazon Bedrock plays
 * the Alexa+ orchestrator — it reads the MCP tool catalog, decides which tools
 * to call, chains them, and phrases the spoken reply. The LLM never bypasses
 * the tools: all life data and all actions flow through the MCP server.
 *
 * Enable with env AWS credentials + LIFEOS_LLM=bedrock.
 * Model: BEDROCK_MODEL_ID (defaults to Claude Sonnet 4.5 cross-region profile).
 *
 * Quota discipline: a circuit breaker remembers Bedrock throttles. Once the
 * account's daily token quota is exhausted, no further Bedrock calls are made
 * until the next UTC day — every turn falls straight through to the rules
 * brain instead of burning a request that is guaranteed to fail.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Message,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import type { CallTool, OrchestratorReply, SessionState, ToolCallRecord } from "./orchestrator.js";
import { absorb } from "./orchestrator.js";

export const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const MAX_TOOL_ROUNDS = 6;

/** The host-model prompt: shared by every LLM that plays the Alexa+ role (Bedrock, Claude API). */
export const SYSTEM = `You are Alexa+, hosting the Align add-on — a proactive, cross-domain life-optimization agent.
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
  return tools.map((t) => {
    // Draft-07 "$schema" markers are noise to the model: dropped from every
    // request. Behaviour (properties, required, enums) is untouched.
    const { $schema: _drop, ...schema } = t.inputSchema;
    return {
      toolSpec: {
        name: t.name,
        // First sentence only — keeps each request's token footprint small so a
        // day-one Bedrock quota stretches across many more conversation turns.
        description: (t.description ?? t.name).split(/(?<=\.)\s+/)[0]!.slice(0, 180),
        inputSchema: { json: schema as never },
      },
    };
  });
}

// ---------------------------------------------------------------- throttle classification
export type ThrottleKind = "day" | "minute" | "other";

export interface ThrottleInfo {
  throttled: boolean;
  kind: ThrottleKind;
  name: string;
  message: string;
  requestId?: string;
}

/** Reads the SDK error shape: name (ThrottlingException…), message, request id. */
export function classifyBedrockError(e: unknown): ThrottleInfo {
  const err = e as { name?: string; message?: string; $metadata?: { requestId?: string } };
  const name = err?.name ?? "Error";
  const message = err?.message ?? String(e);
  const throttled = name === "ThrottlingException" || name === "ServiceQuotaExceededException";
  const kind: ThrottleKind = /per day/i.test(message) ? "day" : /per minute/i.test(message) ? "minute" : "other";
  return { throttled, kind, name, message, requestId: err?.$metadata?.requestId };
}

export const nextUtcMidnight = (nowMs: number): number => {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

export interface CircuitStatus {
  open: boolean;
  until: string | null;
  reason: string | null;
  trips: number;
}

/** Opens on a throttle; stays open until the quota window can plausibly have reset. */
export class BedrockCircuit {
  private openUntil = 0;
  private reason: string | null = null;
  private trips = 0;
  constructor(private readonly now: () => number = Date.now) {}

  isOpen(): boolean {
    return this.now() < this.openUntil;
  }

  /** Returns how long (ms) the circuit will stay open for this throttle kind. */
  trip(info: ThrottleInfo): number {
    const now = this.now();
    // Daily quotas reset on the UTC day boundary; per-minute ones within a minute.
    const until = info.kind === "day" ? Math.max(nextUtcMidnight(now), now + 60_000) : info.kind === "minute" ? now + 60_000 : now + 30_000;
    this.openUntil = until;
    this.reason = `${info.name}: ${info.message}${info.kind === "day" ? " (daily window assumed to reset at 00:00 UTC)" : ""}`;
    this.trips += 1;
    return until - now;
  }

  status(): CircuitStatus {
    const open = this.isOpen();
    return { open, until: open ? new Date(this.openUntil).toISOString() : null, reason: open ? this.reason : null, trips: this.trips };
  }
}

// ---------------------------------------------------------------- brain
export interface BedrockBrainOptions {
  /** Injectable transport (tests); defaults to a real BedrockRuntimeClient. */
  converse?: (input: ConverseCommandInput) => Promise<ConverseCommandOutput>;
  circuit?: BedrockCircuit;
  log?: (s: string) => void;
}

export type BedrockBrain = ((text: string, state: SessionState, callTool: CallTool) => Promise<OrchestratorReply>) & {
  status: () => CircuitStatus & { model: string; region: string };
};

export function makeBedrockBrain(listTools: () => Promise<McpToolDef[]>, opts: BedrockBrainOptions = {}): BedrockBrain {
  const region = process.env.AWS_REGION ?? "us-east-1";
  const circuit = opts.circuit ?? new BedrockCircuit();
  const log = opts.log ?? ((s: string) => console.warn(s));
  const converse =
    opts.converse ??
    (() => {
      const client = new BedrockRuntimeClient({ region });
      return (input: ConverseCommandInput) => client.send(new ConverseCommand(input));
    })();

  // The MCP catalog is static for the life of the server: fetch it once.
  let toolsCache: Tool[] | null = null;
  const tools = async () => (toolsCache ??= toBedrockTools(await listTools()));

  const brain = async function bedrockBrain(text: string, state: SessionState, callTool: CallTool): Promise<OrchestratorReply> {
    if (circuit.isOpen()) {
      const s = circuit.status();
      throw new Error(`bedrock circuit open until ${s.until} — ${s.reason}`);
    }
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
    let inTok = 0;
    let outTok = 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let res: ConverseCommandOutput;
      try {
        res = await converse({
          modelId: MODEL_ID,
          system: [{ text: SYSTEM }],
          messages,
          toolConfig: { tools: await tools() },
          inferenceConfig: { maxTokens: 700, temperature: 0.4 },
        });
      } catch (e) {
        const info = classifyBedrockError(e);
        if (info.throttled) {
          const ms = circuit.trip(info);
          log(
            `bedrock throttled (${info.name}, quota window: per ${info.kind}, requestId=${info.requestId ?? "?"}): ` +
              `circuit open for ${Math.round(ms / 60_000)} min — rules brain only until then`,
          );
        }
        // Tools already ran this turn: their effects are real (a plan may be
        // applied). Finish the turn from their own words rather than throwing —
        // a throw would make the orchestrator re-run the rules brain on the
        // same utterance and execute those tools a second time.
        if (toolCalls.length > 0) {
          log(`bedrock failed mid-turn after ${toolCalls.length} tool call(s) (${info.name}); finishing from tool results`);
          return { reply: toolCalls.map((c) => c.text).filter(Boolean).join(" "), toolCalls, brain: "bedrock" };
        }
        throw e;
      }
      inTok += res.usage?.inputTokens ?? 0;
      outTok += res.usage?.outputTokens ?? 0;
      const msg = res.output?.message;
      if (!msg) break;
      messages.push(msg);

      if (res.stopReason !== "tool_use") {
        log(`bedrock turn: ${round + 1} call(s), ${toolCalls.length} tool(s), tokens in=${inTok} out=${outTok}`);
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
    log(`bedrock turn hit MAX_TOOL_ROUNDS, tokens in=${inTok} out=${outTok}`);
    return { reply: "That took more steps than I expected — here's where I got to.", toolCalls, brain: "bedrock" };
  } as BedrockBrain;

  brain.status = () => ({ ...circuit.status(), model: MODEL_ID, region });
  return brain;
}
