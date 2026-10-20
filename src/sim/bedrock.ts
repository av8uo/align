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

/** Read lazily: .env is loaded by the server after module import. */
export const bedrockModelId = () => process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
const MAX_TOOL_ROUNDS = 6;

/** The host-model prompt: shared by every LLM that plays the Alexa+ role (Bedrock, Claude API). */
export const SYSTEM = `You are Alexa+, hosting the Align add-on — a proactive, cross-domain life-optimization agent.
Rules:
- Answer by CALLING TOOLS; never invent life data. All state lives behind the tools.
- Speak like a helpful voice assistant: short, warm, concrete. At most ~3 sentences unless reading a plan.
- Never execute apply_plan with approve=true unless the user's LAST message clearly consents (yes / do it / apply).
- If the briefing included a question and the user's message answers it, record it with check_in (pass question_id).
- Voice-only parity: never reference screens or buttons; read at most 5 items aloud.
- No technical jargon, tool names, IDs, or JSON in your spoken reply.
- Plain spoken sentences only: no Markdown, no bullet or numbered lists, no bold, no headings — this is read aloud.
- Say ONLY what tool results contain. Never describe, promise, or imply a change the tools did not return.
- You cannot edit a plan. apply_plan applies the latest proposal EXACTLY as propose_plan returned it. If the user wants something different, call propose_plan again (after remember/check_in for new preferences) and read the new plan — or say plainly what cannot be done.
- "Fix it" / "make a plan" means: call propose_plan now and read its result. Never answer it from memory.
- After apply_plan, report what it verified — nothing more.
- Save a preference or fact once. If a tool answers "already noted", don't call it again and don't announce saving it.
- Completion evidence: when the user says what actually happened ("we did date night", "skipped gym Friday", "went twice"), call check_in with completions=[{title|goal_id, status: done|missed, count?, day?}]. Mark ONLY what they explicitly said; never assume a scheduled session happened.
- If the user declines to answer Align's question, call check_in with question_id and decline=true. If they decline a proposed plan, call apply_plan with reject=true (approve=false).
- check_in only FILES A NOTE. It never changes a preference, a goal or a plan — never say "I've updated/changed that" after a check_in. Preferences change only through remember (and only when its result says so); goals only through set_goal.
- A feeling on its own ("I'm exhausted") is not a memory: acknowledge it in the user's words; call check_in only when the message carries a fact, an answer to the open question, or completion evidence.
- To change a goal's target ("gym twice a week now"), call set_goal with the goal's EXACT existing title — that updates it, nothing is duplicated.
- "Thanks" / "bye": one short sentence, no reminders, no new information.
- A question outside the user's own data (general knowledge): answer in one sentence if trivial, then stay on their life; never call a tool for it.
- Self-reported progress with an amount ("I put in 450"): call get_goal_progress to find the matching goal_id, then check_in with goal_id and amount. Don't ask which goal if only one goal fits.
- A CONTEXT block is given each turn from Align's records. Use it: never re-save what it already lists, never re-ask what it answers, never announce "I've saved that" for something already there, never offer a plan again once the context says you already did. Cite it naturally ("you mentioned Leo has football on Wednesdays").
- Reflect the user's actual words before anything else; one focused follow-up at most, only if the answer would change what you do; no forced positivity, no invented details, no summaries nobody asked for.
- Outcomes: say "confirmed" only for what check_in recorded; unconfirmed sessions are "unknown", never "done". Never say a plan "worked" without confirmed evidence.`;

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
  /** Per-turn context block from Align's records (src/sim/context.ts). */
  context?: (state: SessionState, text: string) => string;
  circuit?: BedrockCircuit;
  log?: (s: string) => void;
}

export type BedrockBrain = ((text: string, state: SessionState, callTool: CallTool) => Promise<OrchestratorReply>) & {
  status: () => CircuitStatus & { model: string; region: string };
};

export function makeBedrockBrain(listTools: () => Promise<McpToolDef[]>, opts: BedrockBrainOptions = {}): BedrockBrain {
  const region = process.env.AWS_REGION ?? "us-east-1";
  const circuit = opts.circuit ?? new BedrockCircuit();
  const modelId = bedrockModelId();
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

    const contextBlock = opts.context?.(state, text); // once per turn, stable across tool rounds
    const toolCalls: ToolCallRecord[] = [];
    let inTok = 0;
    let outTok = 0;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let res: ConverseCommandOutput;
      try {
        res = await converse({
          modelId,
          system: contextBlock !== undefined ? [{ text: SYSTEM }, { text: contextBlock }] : [{ text: SYSTEM }],
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

  brain.status = () => ({ ...circuit.status(), model: modelId, region });
  return brain;
}
