/**
 * Brain resilience: if the Bedrock brain fails for ANY reason (expired
 * credentials, region issues, throttling), the conversation silently falls
 * back to the deterministic rules brain — the demo can never die on stage.
 */
import { describe, it, expect } from "vitest";
import { orchestrate, newSession, type ToolCallRecord } from "../src/sim/orchestrator.js";

const stubCallTool = (log: string[]) => async (name: string, args: Record<string, unknown>): Promise<ToolCallRecord> => {
  log.push(name);
  return {
    name,
    args,
    text: "stub reply",
    data: { insights: [{ id: "ins_stub" }], question: null, plan_id: "plan_stub" },
    isError: false,
  };
};

describe("orchestrator resilience", () => {
  it("falls back to the rules brain when Bedrock throws (e.g. ExpiredTokenException)", async () => {
    const log: string[] = [];
    const out = await orchestrate("Good morning", newSession(), {
      callTool: stubCallTool(log),
      bedrock: async () => {
        throw new Error("ExpiredTokenException: The security token included in the request is expired");
      },
    });
    expect(out.brain).toBe("rules");
    expect(log).toContain("get_daily_briefing");
    expect(out.reply.length).toBeGreaterThan(0);
  });

  it("uses Bedrock's reply when the brain succeeds", async () => {
    const log: string[] = [];
    const out = await orchestrate("Good morning", newSession(), {
      callTool: stubCallTool(log),
      bedrock: async () => ({ reply: "bedrock says hi", toolCalls: [], brain: "bedrock" as const }),
    });
    expect(out.brain).toBe("bedrock");
    expect(out.reply).toBe("bedrock says hi");
  });

  it("keeps conversation anchors across brains (history survives a failure)", async () => {
    const log: string[] = [];
    const state = newSession();
    await orchestrate("Good morning", state, { callTool: stubCallTool(log) });
    expect(state.lastInsightId).toBe("ins_stub");
    expect(state.history.length).toBe(2);
  });
});
