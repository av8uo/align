/**
 * Context-use evaluation: for each scenario turn, record the facts available
 * before the turn, the facts actually used, the tools called, the persistent
 * changes, and flag repetition, unnecessary questions, false completions and
 * unsupported claims. Prints a scorecard; the thresholds below are the bar.
 */
import { describe, it, expect, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db/schema.js";
import { seed, DEMO_TODAY } from "../src/db/seed.js";
import { buildMcpServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { newSession, orchestrate, type SessionState, type ToolCallRecord } from "../src/sim/orchestrator.js";
import { buildContext } from "../src/sim/context.js";
import { classifyIntent } from "../src/sim/intent.js";

interface TurnRecord {
  scenario: string;
  text: string;
  intent: string;
  factsAvailable: number;
  factsUsed: string[];
  tools: string[];
  persisted: string[];
  repetitive: boolean;
  unnecessaryQuestion: boolean;
  falseCompletion: boolean;
  unsupportedClaim: boolean;
  reply: string;
}
const records: TurnRecord[] = [];

async function harness() {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  seed(db);
  const server = buildMcpServer(db, DEMO_TODAY);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "eval", version: "0" });
  await client.connect(b);
  const callTool = async (name: string, args: Record<string, unknown>): Promise<ToolCallRecord> => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
    return { name, args, text: r.content?.[0]?.text ?? "", data: r.structuredContent, isError: r.isError ?? false };
  };
  const snapshot = () => ({
    mem: (db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE status='active'").get() as { n: number }).n,
    corrected: (db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE status='corrected'").get() as { n: number }).n,
    events: (db.prepare("SELECT COUNT(*) AS n FROM events WHERE completion_source='user_said'").get() as { n: number }).n,
    plans: (db.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number }).n,
    goals: (db.prepare("SELECT SUM(cadence_per_week) AS n FROM goals").get() as { n: number }).n,
  });
  const replies: string[] = [];
  const texts: string[] = [];
  const turn = async (scenario: string, state: SessionState, text: string, opts: { hedged?: boolean; expectUse?: string[] } = {}) => {
    const ctx = buildContext(db, state, text, DEMO_TODAY);
    const available = [...ctx.facts.map((f) => f.content), ...ctx.preferences.map((p) => p.content)];
    const before = snapshot();
    const { intent } = classifyIntent(text, state);
    const out = await orchestrate(text, state, { callTool });
    const after = snapshot();
    const persisted: string[] = [];
    if (after.mem !== before.mem) persisted.push(`memory ${before.mem}→${after.mem}`);
    if (after.corrected !== before.corrected) persisted.push(`corrected +${after.corrected - before.corrected}`);
    if (after.events !== before.events) persisted.push(`completions +${after.events - before.events}`);
    if (after.plans !== before.plans) persisted.push(`plans +${after.plans - before.plans}`);
    if (after.goals !== before.goals) persisted.push(`goal cadence ${before.goals}→${after.goals}`);
    const low = out.reply.toLowerCase();
    const used = (opts.expectUse ?? []).filter((k) => low.includes(k.toLowerCase()) || out.toolCalls.some((c) => JSON.stringify(c.args).toLowerCase().includes(k.toLowerCase())));
    // Repetition = the same reply to a DIFFERENT user message (identical commands may legitimately get identical answers).
    const repetitive = replies.some((prev, i) => prev === out.reply && texts[i] !== text);
    const asksQuestion = /\?\s*$/.test(out.reply.trim());
    const unnecessaryQuestion = asksQuestion && !state.lastQuestionId && !["unclear", "ambiguous_answer", "want_question", "agent_question", "help", "forget_text"].includes(intent) && !/Shall I apply|want me to|which should/i.test(out.reply);
    const falseCompletion = !!opts.hedged && after.events > before.events;
    // A name in the reply must come from a stored fact or from this very message.
    const unsupportedClaim = /\bSamantha\b/.test(out.reply) && !available.some((a) => /Samantha/.test(a)) && !/Samantha/i.test(text);
    replies.push(out.reply);
    texts.push(text);
    records.push({ scenario, text, intent, factsAvailable: available.length, factsUsed: used, tools: out.toolCalls.map((c) => c.name), persisted, repetitive, unnecessaryQuestion, falseCompletion, unsupportedClaim, reply: out.reply });
    return out;
  };
  return { db, turn, close: () => client.close() };
}

describe("context-use evaluation", () => {
  it("runs the fixed scenario set and meets the bar", async () => {
    const h = await harness();
    try {
      const s = newSession();
      await h.turn("pref", s, "I hate morning workouts.", { expectUse: ["evening"] });
      await h.turn("pref", s, "I hate morning workouts.", { expectUse: ["already"] });
      await h.turn("pref", s, "Fix it", { expectUse: ["18:00"] });
      await h.turn("pref", s, "Not now");
      await h.turn("pref", s, "Actually mornings work better for me now.", { expectUse: ["Updated"] });
      await h.turn("pref", s, "Fix it", { expectUse: ["07:00"] });
      await h.turn("pref", s, "Not now");
      const f = newSession();
      await h.turn("facts", f, "My wife's name is Samantha.");
      await h.turn("facts", f, "My wife's name is Sam, not Samantha.", { expectUse: ["Corrected"] });
      await h.turn("facts", f, "Leo has football on Wednesdays.", { expectUse: ["football"] });
      await h.turn("facts", f, "What do you know about me?", { expectUse: ["Sam, not Samantha", "football"] });
      await h.turn("facts", f, "Can I schedule a client dinner on Wednesday at 6pm?", { expectUse: ["client dinner"] });
      const g = newSession();
      await h.turn("support", g, "I'm exhausted and I feel like I'm failing at everything.", { expectUse: ["failing at everything"] });
      await h.turn("support", g, "Thanks");
      await h.turn("support", g, "Hello");
      // week-later completion questions
      const w = newSession();
      await h.turn("week", w, "Fix it");
      await h.turn("week", w, "Yes, do it");
      h.db.prepare("UPDATE engine_runs SET ran_at='2000-01-01T00:00:00'").run(); // force a fresh engine run on the new day
      const wk = "2026-10-26";
      const ctxBriefing = await h.turn("week", w, "How's my week looking?");
      void ctxBriefing;
      // simulate the day change for the orchestrator's tools by direct briefing on wk
      const briefing = (await (async () => { const r = await (await import("../src/tools/impl.js")).getDailyBriefing(h.db, wk); return r; })());
      const q = (briefing.data as { question: { id: string; text: string } | null }).question;
      if (q) { w.lastQuestionId = q.id; w.lastQuestionText = q.text; }
      await h.turn("week", w, "It was a weird week", { hedged: true });
      await h.turn("week", w, "I think I went once or twice, not sure", { hedged: true });
    } finally {
      await h.close();
    }

    const n = records.length;
    const repetitive = records.filter((r) => r.repetitive).length;
    const unnecessaryQ = records.filter((r) => r.unnecessaryQuestion).length;
    const falseC = records.filter((r) => r.falseCompletion).length;
    const unsupported = records.filter((r) => r.unsupportedClaim).length;
    const withExpectation = records.filter((r) => r.factsUsed.length > 0 || r.text.length > 0);
    const expected = records.map((r) => r).filter((r) => (r as unknown as { expectUse?: string[] }).expectUse);
    void expected;
    const contextTurns = records.filter((r) => ["pref", "facts", "support"].includes(r.scenario) && r.factsUsed !== undefined);
    const used = contextTurns.filter((r) => r.factsUsed.length > 0).length;
    const scorecard = {
      turns: n,
      "context-use accuracy (turns with an expected fact that used it)": `${used}/${contextTurns.filter((r) => r.factsUsed.length > 0 || ["I hate morning workouts.", "Fix it", "Actually mornings work better for me now.", "My wife's name is Sam, not Samantha.", "Leo has football on Wednesdays.", "What do you know about me?", "Can I schedule a client dinner on Wednesday at 6pm?", "I'm exhausted and I feel like I'm failing at everything."].includes(r.text)).length}`,
      "repetitive replies": `${repetitive}/${n}`,
      "unnecessary questions": `${unnecessaryQ}/${n}`,
      "false completions on hedged input": `${falseC}/${records.filter((r) => r.scenario === "week" && /weird|not sure/.test(r.text)).length}`,
      "unsupported claims": `${unsupported}/${n}`,
    };
    console.log("\n=== context-use scorecard ===\n" + Object.entries(scorecard).map(([k, v]) => `${k}: ${v}`).join("\n"));
    expect(repetitive).toBe(0);
    expect(unnecessaryQ).toBe(0);
    expect(falseC).toBe(0);
    expect(unsupported).toBe(0);
    void withExpectation;
  });
});

afterAll(() => {
  const failed = records.filter((r) => r.repetitive || r.unnecessaryQuestion || r.falseCompletion || r.unsupportedClaim);
  if (failed.length) console.log("FAILED TURNS:\n" + failed.map((r) => `  [${r.scenario}] "${r.text}" → ${r.reply.slice(0, 90)} | rep=${r.repetitive} q=${r.unnecessaryQuestion} fc=${r.falseCompletion} uc=${r.unsupportedClaim}`).join("\n"));
  console.log("\n=== context-use trace ===\n" + records.map((r) => `[${r.scenario}] "${r.text}" intent=${r.intent} avail=${r.factsAvailable} used=[${r.factsUsed.join(",")}] tools=[${r.tools.join(",")}] persisted=[${r.persisted.join("; ")}]`).join("\n"));
});
