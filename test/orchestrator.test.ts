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

describe("rules brain: conversation vs memory", () => {
  const briefingWithQuestion = async (name: string, args: Record<string, unknown>): Promise<ToolCallRecord> => ({
    name, args, text: "briefing", isError: false,
    data: { insights: [{ id: "ins_1" }], question: { id: "q_1", text: "How are things with Sam lately?" } },
  });

  it("does not file questions aimed at Align as memories", async () => {
    const log: string[] = [];
    const callTool = stubCallTool(log);
    const a = await orchestrate("Hey, can you listen?", newSession(), { callTool });
    const b = await orchestrate("Who are you?", newSession(), { callTool });
    expect(a.reply).toMatch(/listening/i);
    expect(b.reply).toMatch(/^I'm Align/);
    expect(log).toEqual([]);
  });

  it("answers 'what do you want to know about me?' with Align's open question", async () => {
    const out = await orchestrate("What do you want to know about me?", newSession(), { callTool: briefingWithQuestion });
    expect(out.toolCalls.map((c) => c.name)).toEqual(["get_daily_briefing"]);
    expect(out.reply).toBe("One thing I'd like to know: How are things with Sam lately?");
  });

  it("routes 'how am I doing this week?' to the briefing", async () => {
    const log: string[] = [];
    await orchestrate("How am I doing this week?", newSession(), { callTool: stubCallTool(log) });
    expect(log).toEqual(["get_daily_briefing"]);
  });

  it("still treats a plain statement as a check-in, and an answer to the open question as its answer", async () => {
    const log: string[] = [];
    const callTool = stubCallTool(log);
    await orchestrate("Work has been brutal lately.", newSession(), { callTool });
    const s = newSession();
    s.lastQuestionId = "q_1";
    await orchestrate("Not great, honestly — do you think it shows?", s, { callTool });
    expect(log).toEqual(["check_in", "check_in"]);
  });
});

describe("rules brain: repeating the open question", () => {
  it("repeats the question Align already asked today when asked what it wants to know", async () => {
    const log: string[] = [];
    const s = newSession();
    // The proactive briefing already asked the day's one question.
    s.lastQuestionId = "q_1";
    s.lastQuestionText = "How are things with Sam lately?";
    const out = await orchestrate("What do you want to know about me?", s, { callTool: stubCallTool(log) });
    expect(out.reply).toBe("Earlier I asked: How are things with Sam lately? Whenever you're ready.");
    expect(log).toEqual(["get_daily_briefing"]);
    expect(s.lastQuestionId).toBe("q_1"); // not cleared: the answer is still welcome
  });
});

describe("rules brain: a question to Align is never mistaken for the answer to Align's question", () => {
  it("keeps the open question open when the user asks something first, then records the real answer", async () => {
    const log: string[] = [];
    const s = newSession();
    s.lastQuestionId = "q_1";
    s.lastQuestionText = "How are things with Sam lately?";
    const a = await orchestrate("Hey, can you listen?", s, { callTool: stubCallTool(log) });
    expect(a.reply).toBe("I'm listening — go ahead.");
    expect(log).toEqual([]);
    expect(s.lastQuestionId).toBe("q_1");
    const b = await orchestrate("Honestly we barely talk, work is eating everything.", s, { callTool: async (name, args) => { log.push(name); return { name, args, text: "noted", data: {}, isError: false }; } });
    expect(log).toEqual(["check_in"]);
    expect(b.toolCalls[0]!.args).toMatchObject({ question_id: "q_1" });
    expect(s.lastQuestionId).toBeNull();
  });
});
