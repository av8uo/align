/**
 * Brain resilience: if the Bedrock brain fails for ANY reason (expired
 * credentials, region issues, throttling), the conversation silently falls
 * back to the deterministic rules brain — the demo can never die on stage.
 */
import { describe, it, expect } from "vitest";
import { briefingKey, orchestrate, newSession, type ToolCallRecord } from "../src/sim/orchestrator.js";

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

describe("rules brain: small talk, declines, direct edits, forget-by-text, what-if moves", () => {
  const withQuestion = () => { const s = newSession(); s.lastQuestionId = "q_1"; s.lastQuestionText = "How are things with Sam lately?"; return s; };

  it("greets back without a tool call and keeps the open question open", async () => {
    const log: string[] = [];
    const s = withQuestion();
    const out = await orchestrate("Hello", s, { callTool: stubCallTool(log) });
    expect(out.reply).toBe("Hi. How are things with Sam lately?");
    expect(log).toEqual([]);
    expect(s.lastQuestionId).toBe("q_1");
  });

  it("handles thanks, good night, never mind and help conversationally", async () => {
    const log: string[] = [];
    const callTool = stubCallTool(log);
    expect((await orchestrate("Thanks!", newSession(), { callTool })).reply).toBe("Any time.");
    expect((await orchestrate("Good night", newSession(), { callTool })).reply).toMatch(/^Good night\./);
    expect((await orchestrate("Never mind", newSession(), { callTool })).reply).toBe("Okay, dropped.");
    expect((await orchestrate("Help", newSession(), { callTool })).reply).toMatch(/^I can brief you/);
    expect(log).toEqual([]);
  });

  it("declines a pending plan without applying it; a bare yes with nothing pending applies nothing", async () => {
    const log: string[] = [];
    const callTool = stubCallTool(log);
    const s = newSession();
    s.lastPlanId = "plan_1";
    s.planAwaitingApproval = true;
    const out = await orchestrate("Not now", s, { callTool });
    expect(out.reply).toMatch(/leave your week as it is/);
    expect(s.planAwaitingApproval).toBe(false);
    expect(log).toEqual(["apply_plan"]); // the decline is recorded as acceptance evidence (reject=true), nothing applied
    expect((await orchestrate("Yes", newSession(), { callTool })).reply).toMatch(/Nothing is waiting on a yes/);
    expect(log).toEqual(["apply_plan"]);
  });

  it("is honest that direct calendar edits go through a plan", async () => {
    const log: string[] = [];
    const out = await orchestrate("Move date night to Saturday", newSession(), { callTool: stubCallTool(log) });
    expect(out.reply).toMatch(/don't edit your calendar on command/);
    expect(log).toEqual([]);
  });

  it("forgets a memory by description via review_memory → forget", async () => {
    const log: string[] = [];
    const callTool = async (name: string, args: Record<string, unknown>): Promise<ToolCallRecord> => {
      log.push(`${name}:${JSON.stringify(args)}`);
      return name === "review_memory"
        ? { name, args, text: "", data: { memories: [{ id: "mem_9", kind: "preference", content: "I hate morning gym." }] }, isError: false }
        : { name, args, text: "Forgotten.", data: { memory_id: "mem_9" }, isError: false };
    };
    const out = await orchestrate("Forget the morning gym thing", newSession(), { callTool });
    expect(log).toEqual(['review_memory:{"filter":"morning gym"}', 'forget:{"memory_id":"mem_9"}']);
    expect(out.reply).toBe('Forgotten: "I hate morning gym".');
  });

  it("simulates 'what if I move gym to Friday at 6pm'", async () => {
    const log: string[] = [];
    const out = await orchestrate("What if I move gym to Friday at 6pm?", newSession(), {
      callTool: async (name, args) => { log.push(name); return { name, args, text: "sim", data: {}, isError: false }; },
    });
    expect(log).toEqual(["simulate_change"]);
    expect(out.toolCalls[0]!.args).toEqual({ title: "gym", day: "Friday", start_time: "18:00" });
  });

  it("a feeling is acknowledged in the user's own words, with no tool call, and the open question stays open", async () => {
    const log: string[] = [];
    const s = withQuestion();
    const out = await orchestrate("I'm exhausted", s, { callTool: async (name, args) => { log.push(name); return { name, args, text: "noted", data: {}, isError: false }; } });
    expect(log).toEqual([]);
    expect(out.reply).toMatch(/^That's a lot — i'm exhausted\./);
    expect(out.reply).toContain("How are things with Sam lately?"); // the open question is mentioned once, not re-asked verbatim later
    expect(s.lastQuestionId).toBe("q_1");
  });
});

describe("rules brain: review fixes", () => {
  const withQuestion = () => { const s = newSession(); s.lastQuestionId = "q_1"; s.lastQuestionText = "How are things with Sam lately?"; return s; };
  const recorder = (log: Array<{ name: string; args: Record<string, unknown> }>) => async (name: string, args: Record<string, unknown>): Promise<ToolCallRecord> => {
    log.push({ name, args });
    return { name, args, text: "ok", data: { insights: [{ id: "ins_1" }], question: null }, isError: false };
  };

  it("records a free-text answer containing route words (why, plan, goals) as the answer", async () => {
    for (const answer of ["Honestly I don't know why, we barely talk.", "We only talk about the kids' goals and my work plan.", "Fine overall, I guess."]) {
      const log: Array<{ name: string; args: Record<string, unknown> }> = [];
      const s = withQuestion();
      await orchestrate(answer, s, { callTool: recorder(log) });
      expect(log.map((c) => c.name)).toEqual(["check_in"]);
      expect(log[0]!.args).toMatchObject({ question_id: "q_1", content: answer });
    }
  });

  it("still routes real commands: 'why?', 'fix it', 'how am I doing on my goals?', 'how am I doing this week?'", async () => {
    const s = newSession();
    s.lastInsightId = "ins_1";
    const log: Array<{ name: string; args: Record<string, unknown> }> = [];
    for (const cmd of ["Why?", "Fix it", "How am I doing on my goals?", "How am I doing this week?"]) await orchestrate(cmd, s, { callTool: recorder(log) });
    expect(log.map((c) => c.name)).toEqual(["get_insight", "propose_plan", "get_goal_progress", "get_daily_briefing"]);
  });

  it("logs 'Put 450 in the house fund' as savings, not a calendar edit", async () => {
    const log: Array<{ name: string; args: Record<string, unknown> }> = [];
    await orchestrate("Put 450 in the house fund", newSession(), { callTool: recorder(log) });
    expect(log[0]).toMatchObject({ name: "check_in", args: { goal_id: "goal_house", amount: 450 } });
  });

  it("records a bare yes/no as the answer while a YES/NO question is open (not for an open-ended one)", async () => {
    const log: Array<{ name: string; args: Record<string, unknown> }> = [];
    const s = withQuestion();
    s.lastQuestionText = "Did date night with Sam happen on Friday?";
    const stray = await orchestrate("No", { ...withQuestion() }, { callTool: recorder(log) }); // open-ended question: "No" is not an answer
    expect(log).toEqual([]);
    expect(stray.reply).toBe("Okay.");
    await orchestrate("No", s, { callTool: recorder(log) });
    expect(log[0]).toMatchObject({ name: "check_in", args: { question_id: "q_1", content: "No" } });
  });

  it("refuses to forget when the description matches several memories", async () => {
    const log: string[] = [];
    const callTool = async (name: string, args: Record<string, unknown>): Promise<ToolCallRecord> => {
      log.push(name);
      return { name, args, text: "", data: { memories: [{ id: "a", content: "Felt great after morning gym." }, { id: "b", content: "I hate morning gym." }] }, isError: false };
    };
    const out = await orchestrate("Forget gym", newSession(), { callTool });
    expect(log).toEqual(["review_memory"]);
    expect(out.reply).toMatch(/^I have 2 memories mentioning that: "Felt great after morning gym"; "I hate morning gym"\./);
  });

  it("does not read 'I'm low on cash' as a feeling", async () => {
    const log: Array<{ name: string; args: Record<string, unknown> }> = [];
    const out = await orchestrate("I'm low on cash this month", newSession(), { callTool: recorder(log) });
    expect(log.map((c) => c.name)).toEqual(["check_in"]);
    expect(out.reply).not.toMatch(/sorry/i);
  });
});

describe("rules brain: a briefing is never read twice verbatim", () => {
  const briefing = async (name: string, args: Record<string, unknown>): Promise<ToolCallRecord> => ({
    name, args, isError: false,
    text: "Here's your briefing. Work is crowding out your family time. Lowest balance: family at 6.",
    data: { headline: "Work is crowding out your family time", balance: [{ domain: "work", score: 68 }, { domain: "family", score: 6 }, { domain: "personal", score: 11 }, { domain: "finance", score: null }], insights: [{ id: "ins_1" }], question: null },
  });

  it("recaps from the briefing's own data when the briefing hasn't changed", async () => {
    const s = newSession();
    const first = await orchestrate("How's my week looking?", s, { callTool: briefing });
    const second = await orchestrate("How's my week looking?", s, { callTool: briefing });
    expect(first.reply).toMatch(/^Here's your briefing/);
    expect(second.reply).toBe('Nothing new since my last briefing — Work is crowding out your family time; lowest balances family at 6 and personal at 11. Say "fix it" for a plan, or "tell me more" for the evidence.');
  });

  it("treats the proactive briefing as already delivered", async () => {
    const s = newSession();
    s.lastBriefingKey = briefingKey({ headline: "Work is crowding out your family time", balance: [{ domain: "work", score: 68 }, { domain: "family", score: 6 }, { domain: "personal", score: 11 }, { domain: "finance", score: null }], insights: [{ id: "ins_1" }], outcomes: [] });
    const out = await orchestrate("How's my week looking?", s, { callTool: briefing });
    expect(out.reply).toMatch(/^Nothing new since my last briefing/);
  });

  it("reads a changed briefing in full (e.g. after the week-later jump)", async () => {
    const s = newSession();
    s.lastBriefingKey = briefingKey({ headline: "an older briefing", insights: [{ id: "ins_0" }], balance: [], outcomes: [] });
    const out = await orchestrate("How's my week looking?", s, { callTool: briefing });
    expect(out.reply).toMatch(/^Here's your briefing/);
  });
});

describe("rules brain: wishes are kept as goals; offers can be accepted", () => {
  it("keeps 'I want to have a better relationship with my wife' as a goal note, not as the answer to the open question", async () => {
    const log: Array<{ name: string; args: Record<string, unknown> }> = [];
    const s = newSession();
    s.lastQuestionId = "q_1";
    const out = await orchestrate("i want to have better relation with my wife", s, {
      callTool: async (name, args) => { log.push({ name, args }); return { name, args, text: "Remembered as a goal_note.", data: {}, isError: false }; },
    });
    expect(log).toEqual([{ name: "remember", args: { content: "i want to have better relation with my wife", kind: "goal_note" } }]);
    expect(out.reply).toMatch(/^That's a goal worth planning around/);
    expect(s.lastQuestionId).toBe("q_1");
  });

  it("honors 'want me to find one?' — yes tries the other days with simulate_change and reports the first that fits", async () => {
    const asked: string[] = [];
    const callTool = async (name: string, args: Record<string, unknown>): Promise<ToolCallRecord> => {
      asked.push(`${name}:${args.day}`);
      const safe = args.day === "Saturday";
      return { name, args, text: safe ? "fits" : "collides", data: { recommendation: safe ? "safe" : "reschedule" }, isError: false };
    };
    const s = newSession();
    const first = await orchestrate("What if I take a client dinner on Thursday at 7pm?", s, { callTool });
    expect(first.toolCalls[0]!.args).toEqual({ title: "client dinner", day: "Thursday", start_time: "19:00" });
    expect(s.pendingOffer).toEqual({ kind: "find_slot", title: "client dinner", day: "Thursday", start_time: "19:00" });
    const yes = await orchestrate("Yes", s, { callTool });
    expect(asked).toEqual(["simulate_change:Thursday", "simulate_change:Friday", "simulate_change:Saturday"]);
    expect(yes.reply).toBe('Saturday at 19:00 works for "client dinner" — no conflicts, and none of your goals lose their slot. Say "fix it" if you want it in a plan.');
    expect(s.pendingOffer).toBeNull();
  });

  it("'no' declines the offer without any tool call", async () => {
    const s = newSession();
    s.pendingOffer = { kind: "find_slot", title: "client dinner", day: "Thursday", start_time: "19:00" };
    const log: string[] = [];
    const out = await orchestrate("No thanks", s, { callTool: stubCallTool(log) });
    expect(out.reply).toBe("Okay, leaving it.");
    expect(log).toEqual([]);
    expect(s.pendingOffer).toBeNull();
  });
});
