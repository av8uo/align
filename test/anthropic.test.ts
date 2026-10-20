/**
 * Claude-API host brain: same contract as the Bedrock brain — tools decide,
 * the model speaks; any failure falls back to the rules brain; a failure after
 * tools ran never re-runs them. Transport is injected: no network, no key.
 */
import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { makeAnthropicBrain, toAnthropicTools } from "../src/sim/anthropic.js";
import { newSession, orchestrate, type CallTool } from "../src/sim/orchestrator.js";

const tools = async () => [
  { name: "get_daily_briefing", description: "Briefing. Use for good morning.", inputSchema: { $schema: "x", type: "object", properties: {} } },
];
const callTool: CallTool = async (name, args) => ({ name, args, text: `ran ${name}`, data: { insights: [{ id: "ins_1" }], question: null }, isError: false });

const msg = (content: Anthropic.ContentBlock[], stop_reason: Anthropic.Message["stop_reason"]): Anthropic.Message =>
  ({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 5 } }) as unknown as Anthropic.Message;

describe("Claude-API brain", () => {
  it("keeps full tool descriptions and drops $schema", () => {
    const [t] = toAnthropicTools([{ name: "x", description: "First. Second.", inputSchema: { $schema: "s", type: "object" } }]);
    expect(t).toMatchObject({ name: "x", description: "First. Second.", input_schema: { type: "object" } });
  });

  it("runs the tool loop and returns the model's spoken reply", async () => {
    const seen: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const brain = makeAnthropicBrain(tools, {
      create: async (p) => {
        seen.push({ ...p, messages: [...p.messages] }); // snapshot: the brain mutates its messages array after the call
        return seen.length === 1
          ? msg([{ type: "tool_use", id: "t1", name: "get_daily_briefing", input: {} } as Anthropic.ToolUseBlock], "tool_use")
          : msg([{ type: "text", text: "Here's your morning.", citations: null } as Anthropic.TextBlock], "end_turn");
      },
      log: () => {},
    });
    const state = newSession();
    const out = await orchestrate("good morning", state, { callTool, bedrock: brain });
    expect(out).toMatchObject({ brain: "anthropic", reply: "Here's your morning." });
    expect(out.toolCalls.map((c) => c.name)).toEqual(["get_daily_briefing"]);
    expect(state.lastInsightId).toBe("ins_1");
    expect(seen[0]!.model).toBe("claude-opus-5-5");
    expect(seen[1]!.messages.at(-1)).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] });
  });

  it("falls back to the rules brain when the API fails before any tool ran", async () => {
    const brain = makeAnthropicBrain(tools, { create: async () => { throw Object.assign(new Error("401"), { status: 401 }); }, log: () => {} });
    const out = await orchestrate("good morning", newSession(), { callTool, bedrock: brain });
    expect(out.brain).toBe("rules");
  });

  it("finishes from tool results when the API fails after tools ran (no double execution)", async () => {
    let n = 0;
    const ran: string[] = [];
    const brain = makeAnthropicBrain(tools, {
      create: async () => {
        n += 1;
        if (n === 1) return msg([{ type: "tool_use", id: "t1", name: "apply_plan", input: { plan_id: "p", approve: true } } as Anthropic.ToolUseBlock], "tool_use");
        throw new Error("boom");
      },
      log: () => {},
    });
    const out = await orchestrate("yes, do it", newSession(), {
      callTool: async (name, args) => { ran.push(name); return { name, args, text: "Done and verified.", data: {}, isError: false }; },
      bedrock: brain,
    });
    expect(ran).toEqual(["apply_plan"]);
    expect(out).toMatchObject({ brain: "anthropic", reply: "Done and verified." });
  });

  it("reports itself unconfigured without a key and lets the rules brain answer", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const brain = makeAnthropicBrain(tools, { log: () => {} });
      expect(brain.status()).toMatchObject({ provider: "anthropic", configured: false });
      const out = await orchestrate("good morning", newSession(), { callTool, bedrock: brain });
      expect(out.brain).toBe("rules");
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });
});
