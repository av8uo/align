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
  it("after the time jump, LifeOS proactively reports measured results and asks about the NEW gap (finances)", async () => {
    const adv = (await (await fetch(`${base}/demo/advance`, { method: "POST" })).json()) as { today: string };
    expect(adv.today).toBe("2026-10-26");
    const r = (await get("/proactive?session_id=demo")) as { quiet: boolean; text: string; data: { outcomes: unknown[] } };
    expect(r.quiet).toBe(false);
    expect(r.text).toContain("Results from last week's plan");
    expect(r.text).toContain("house fund"); // the inquiry engine moved on to the finance gap
    expect(r.data.outcomes.length).toBeGreaterThanOrEqual(4);
  });

  it("self-reported savings log with pacing arithmetic (user's own numbers, no advice)", async () => {
    const r = await chat("I put in 450");
    expect(r.toolCalls[0]?.name).toBe("check_in");
    expect(r.reply).toContain("$50 short");
  });

  it("'how did my week go' → the hypothesis is reported as confirmed", async () => {
    const r = await chat("How did my week go?");
    expect(r.toolCalls[0]?.name).toBe("whats_changed");
    expect(r.reply).toContain("Hypothesis confirmed");
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
