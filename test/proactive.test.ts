/**
 * The differentiator under test: proactive, cross-domain intelligence.
 *  - LifeOS speaks FIRST when the engine found something (via /proactive)
 *  - and stays QUIET when nothing needs attention (vision §8)
 *  - a full multi-turn conversation drives real MCP tools through /chat
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { migrate } from "../src/db/schema.js";
import { seed, DEMO_TODAY } from "../src/db/seed.js";
import { createLifeOsHttpServer } from "../src/server.js";

let server: ReturnType<typeof createLifeOsHttpServer>;
let base: string;

const get = async (p: string) => (await fetch(`${base}${p}`)).json() as Promise<Record<string, unknown>>;
const chat = async (text: string) => {
  const r = await fetch(`${base}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: "demo", text }),
  });
  return (await r.json()) as { reply: string; toolCalls: Array<{ name: string; data?: Record<string, unknown>; isError: boolean }>; brain: string };
};

beforeAll(async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  seed(db);
  server = createLifeOsHttpServer(db, DEMO_TODAY);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe("proactive channel", () => {
  it("speaks first when the engine found something — cross-domain, with the question", async () => {
    const r = (await get("/proactive")) as { quiet: boolean; text: string };
    expect(r.quiet).toBe(false);
    expect(r.text).toContain("Work is crowding");
    expect(r.text).toContain("Sam");
    // Respects uncertainty: before the user confirms, the insight is hedged.
    expect(r.text).toContain("not fully sure");
  });

  it("stays quiet once everything has been surfaced (proactive ≠ interrupting)", async () => {
    const r = (await get("/proactive")) as { quiet: boolean };
    expect(r.quiet).toBe(true);
  });
});

describe("conversation through the simulated Alexa+ host (rules brain)", () => {
  it("answering the open question becomes memory via check_in", async () => {
    const r = await chat("Honestly we barely talk, work is eating everything.");
    expect(r.toolCalls[0]?.name).toBe("check_in");
    expect(r.brain).toBe("rules");
  });

  it("'how's my week looking' → briefing with cross-domain content, hedge GONE after the user confirmed", async () => {
    const r = await chat("How's my week looking?");
    expect(r.toolCalls[0]?.name).toBe("get_daily_briefing");
    expect(r.reply).toContain("Work is crowding");
    // The check-in raised the insight's confidence past the bar: no more hedging.
    expect(r.reply).not.toContain("not fully sure");
  });

  it("'fix it' → a concrete multi-domain plan awaiting approval", async () => {
    const r = await chat("Okay, fix it.");
    expect(r.toolCalls[0]?.name).toBe("propose_plan");
    const changes = (r.toolCalls[0]!.data as { changes: Array<{ domain: string }> }).changes;
    expect(new Set(changes.map((c) => c.domain)).size).toBeGreaterThanOrEqual(3); // family+health+personal+work
    expect(r.reply).toContain("Shall I apply it?");
    // Every plan is a measurable experiment, declared up front.
    expect(r.reply).toContain("my hypothesis");
  });

  it("'yes, do it' → verified execution", async () => {
    const r = await chat("Yes, do it.");
    expect(r.toolCalls[0]?.name).toBe("apply_plan");
    expect((r.toolCalls[0]!.data as { allVerified: boolean }).allVerified).toBe(true);
    expect(r.reply).toContain("verified");
  });

  it("what-if simulation: previews a collision BEFORE the user commits", async () => {
    const r = await chat("What if I take a client dinner on Thursday at 7pm?");
    expect(r.toolCalls[0]?.name).toBe("simulate_change");
    expect(r.reply).toContain("School recital"); // collides with Maya's recital
    expect(r.reply).toContain("different slot");
  });

  it("'what do you know about me' → memory transparency", async () => {
    const r = await chat("What do you know about me?");
    expect(r.toolCalls[0]?.name).toBe("review_memory");
  });
});

describe("one week later: measure, adapt, next knowledge gap", () => {
  it("after the time jump, Align says it can't tell whether the plan happened and asks the completion question", async () => {
    const adv = (await (await fetch(`${base}/demo/advance`, { method: "POST" })).json()) as { today: string };
    expect(adv.today).toBe("2026-10-26");
    const r = (await get("/proactive?session_id=demo")) as { quiet: boolean; text: string; data: { outcomes: Array<{ verdict: string }>; question: { text: string } | null } };
    expect(r.quiet).toBe(false);
    expect(r.text).toContain("can't tell yet whether they happened");
    expect(r.text).not.toMatch(/all improved|went 0 to/);
    expect(r.data.outcomes.length).toBeGreaterThanOrEqual(4);
    expect(r.data.outcomes.every((o) => o.verdict === "inconclusive")).toBe(true);
    expect(r.data.question?.text).toBe("Did date night with Sam happen on Friday?"); // discovered completion gap, named from the stated fact
  });

  it("the answer becomes completion evidence and the verdict updates from it", async () => {
    const r = await chat("Yes, we did!");
    expect(r.toolCalls[0]?.name).toBe("check_in");
    expect(r.reply).toContain("recorded that as done");
    expect(r.reply).toContain("family (date night): improved");
  });

  it("stated completions ('went to the gym twice') are recorded as evidence, nothing else assumed", async () => {
    const r = await chat("I went to the gym twice");
    expect(r.toolCalls[0]?.name).toBe("check_in");
    expect((r.toolCalls[0]!.data as { completions_recorded: string[] }).completions_recorded.length).toBe(2);
  });

  it("self-reported savings log with pacing arithmetic (user's own numbers, no advice)", async () => {
    const r = await chat("I put in 450");
    expect(r.toolCalls[0]?.name).toBe("check_in");
    expect(r.reply).toContain("$50 short");
  });

  it("'how did my week go' → confirmed results are separated from unknowns; no causal claim", async () => {
    const r = await chat("How did my week go?");
    expect(r.toolCalls[0]?.name).toBe("whats_changed");
    expect(r.reply).toContain("Confirmed so far: family (date night) 0 to 1 of 1 (improved)");
    expect(r.reply).toContain("health (gym) 1 to 2 of 3 (improved)");
    expect(r.reply).toContain("Still unknown: personal (spanish practice)");
    expect(r.reply).toContain("can't prove the plan caused it");
    expect((r.toolCalls[0]!.data as { attribution: string }).attribution).toBe("association");
  });

  it("reset restores day one", async () => {
    await fetch(`${base}/demo/reset`, { method: "POST" });
    const h = (await get("/healthz")) as { today: string };
    expect(h.today).toBe("2026-10-19");
    const r = (await get("/proactive")) as { quiet: boolean; text: string };
    expect(r.quiet).toBe(false);
    expect(r.text).toContain("Sam");
  });
});

describe("visible preference learning (smarter about YOU)", () => {
  it("a spoken dislike becomes a durable preference", async () => {
    const r = await chat("Actually, I hate morning gym");
    expect(r.toolCalls[0]?.name).toBe("remember");
    expect(r.reply).toContain("Preference saved");
  });

  it("the NEXT plan proposes gym in the evening instead", async () => {
    const r = await chat("Okay, fix it.");
    const propose = r.toolCalls.find((c) => c.name === "propose_plan")!;
    const gym = (propose.data as { changes: Array<{ title: string; start?: string }> }).changes.filter(
      (c) => c.title === "Gym",
    );
    expect(gym.length).toBeGreaterThanOrEqual(2);
    for (const g of gym) expect(g.start).toContain("T18:00");
  });
});
