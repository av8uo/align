/**
 * Bedrock brain quota discipline: throttles open a circuit breaker so the
 * server stops spending requests on a quota that is already exhausted, and
 * the rules brain keeps answering. The Bedrock transport is injected — no
 * network, no credentials.
 */
import { describe, expect, it } from "vitest";
import type { ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import {
  BedrockCircuit,
  classifyBedrockError,
  makeBedrockBrain,
  nextUtcMidnight,
  toBedrockTools,
} from "../src/sim/bedrock.js";
import { newSession, orchestrate, type CallTool } from "../src/sim/orchestrator.js";

const tools = async () => [
  { name: "get_daily_briefing", description: "Briefing. Second sentence is dropped.", inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: {} } },
];
const callTool: CallTool = async (name, args) => ({ name, args, text: `ran ${name}`, data: {}, isError: false });

const throttle = (message: string) => Object.assign(new Error(message), { name: "ThrottlingException", $metadata: { requestId: "req-1" } });
const textReply = (text: string): ConverseCommandOutput =>
  ({ output: { message: { role: "assistant", content: [{ text }] } }, stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, metrics: { latencyMs: 1 }, $metadata: {} }) as ConverseCommandOutput;

describe("Bedrock tool payload", () => {
  it("drops $schema and keeps only the first sentence of each description", () => {
    const [t] = toBedrockTools([{ name: "x", description: "First. Second.", inputSchema: { $schema: "s", type: "object" } }]);
    expect(t!.toolSpec!.description).toBe("First.");
    expect(t!.toolSpec!.inputSchema!.json).toEqual({ type: "object" });
  });
});

describe("throttle classification", () => {
  it("recognises the daily and per-minute Bedrock quota messages", () => {
    expect(classifyBedrockError(throttle("Too many tokens per day, please wait before trying again."))).toMatchObject({ throttled: true, kind: "day", requestId: "req-1" });
    expect(classifyBedrockError(throttle("Too many tokens per minute"))).toMatchObject({ throttled: true, kind: "minute" });
    expect(classifyBedrockError(Object.assign(new Error("boom"), { name: "AccessDeniedException" }))).toMatchObject({ throttled: false });
  });

  it("computes the next UTC day boundary", () => {
    expect(new Date(nextUtcMidnight(Date.UTC(2026, 9, 20, 10, 30))).toISOString()).toBe("2026-10-21T00:00:00.000Z");
  });
});

describe("circuit breaker", () => {
  it("opens until the next UTC midnight on a daily-quota throttle and closes afterwards", () => {
    let now = Date.UTC(2026, 9, 20, 10, 0);
    const c = new BedrockCircuit(() => now);
    expect(c.isOpen()).toBe(false);
    c.trip(classifyBedrockError(throttle("Too many tokens per day")));
    expect(c.status()).toMatchObject({ open: true, until: "2026-10-21T00:00:00.000Z", trips: 1 });
    now = Date.UTC(2026, 9, 20, 23, 59);
    expect(c.isOpen()).toBe(true);
    now = Date.UTC(2026, 9, 21, 0, 0);
    expect(c.isOpen()).toBe(false);
  });

  it("opens for only a minute on a per-minute throttle", () => {
    let now = 1_000_000;
    const c = new BedrockCircuit(() => now);
    c.trip(classifyBedrockError(throttle("Too many tokens per minute")));
    now += 59_000;
    expect(c.isOpen()).toBe(true);
    now += 2_000;
    expect(c.isOpen()).toBe(false);
  });
});

describe("Bedrock brain with the circuit", () => {
  it("makes exactly one request after a daily throttle, then falls back to rules without calling Bedrock", async () => {
    let sent = 0;
    const logs: string[] = [];
    const brain = makeBedrockBrain(tools, {
      converse: async () => {
        sent += 1;
        throw throttle("Too many tokens per day, please wait before trying again.");
      },
      log: (s) => logs.push(s),
    });
    const state = newSession();
    const first = await orchestrate("good morning", state, { callTool, bedrock: brain });
    const second = await orchestrate("good morning", state, { callTool, bedrock: brain });
    expect(first.brain).toBe("rules");
    expect(second.brain).toBe("rules");
    expect(sent).toBe(1);
    expect(brain.status()).toMatchObject({ open: true, trips: 1 });
    expect(logs.some((l) => l.includes("per day"))).toBe(true);
  });

  it("answers from Bedrock when the quota is available and reports token usage", async () => {
    const logs: string[] = [];
    const brain = makeBedrockBrain(tools, { converse: async () => textReply("hi from bedrock"), log: (s) => logs.push(s) });
    const out = await orchestrate("hello", newSession(), { callTool, bedrock: brain });
    expect(out).toMatchObject({ brain: "bedrock", reply: "hi from bedrock" });
    expect(brain.status().open).toBe(false);
    expect(logs.some((l) => l.includes("in=100 out=10"))).toBe(true);
  });

  it("fetches the MCP tool catalog once per server, not once per turn", async () => {
    let listed = 0;
    const brain = makeBedrockBrain(
      async () => {
        listed += 1;
        return tools();
      },
      { converse: async () => textReply("ok"), log: () => {} },
    );
    await orchestrate("a", newSession(), { callTool, bedrock: brain });
    await orchestrate("b", newSession(), { callTool, bedrock: brain });
    expect(listed).toBe(1);
  });
});

describe("Bedrock brain: failure after tools already ran", () => {
  it("finishes the turn from tool results instead of throwing, so the fallback never re-runs the tools", async () => {
    let sent = 0;
    const toolUse = (): ConverseCommandOutput =>
      ({ output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "apply_plan", input: { plan_id: "plan_1", approve: true } } }] } }, stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, metrics: { latencyMs: 1 }, $metadata: {} }) as ConverseCommandOutput;
    const brain = makeBedrockBrain(tools, {
      converse: async () => {
        sent += 1;
        if (sent === 1) return toolUse();
        throw throttle("Too many tokens per day, please wait before trying again.");
      },
      log: () => {},
    });
    const ran: string[] = [];
    const out = await orchestrate("yes, do it", newSession(), {
      callTool: async (name, args) => { ran.push(name); return { name, args, text: "Done and verified — all 8 changes are on the calendar.", data: {}, isError: false }; },
      bedrock: brain,
    });
    expect(ran).toEqual(["apply_plan"]);
    expect(out).toMatchObject({ brain: "bedrock", reply: "Done and verified — all 8 changes are on the calendar." });
    expect(brain.status().open).toBe(true);
  });
});
