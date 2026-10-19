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

  it("'how's my week looking' → briefing with cross-domain content", async () => {
    const r = await chat("How's my week looking?");
    expect(r.toolCalls[0]?.name).toBe("get_daily_briefing");
    expect(r.reply).toContain("Work is crowding");
  });

  it("'fix it' → a concrete multi-domain plan awaiting approval", async () => {
    const r = await chat("Okay, fix it.");
    expect(r.toolCalls[0]?.name).toBe("propose_plan");
    const changes = (r.toolCalls[0]!.data as { changes: Array<{ domain: string }> }).changes;
    expect(new Set(changes.map((c) => c.domain)).size).toBeGreaterThanOrEqual(3); // family+health+personal+work
    expect(r.reply).toContain("Shall I apply it?");
  });

  it("'yes, do it' → verified execution", async () => {
    const r = await chat("Yes, do it.");
    expect(r.toolCalls[0]?.name).toBe("apply_plan");
    expect((r.toolCalls[0]!.data as { allVerified: boolean }).allVerified).toBe(true);
    expect(r.reply).toContain("verified");
  });

  it("'what do you know about me' → memory transparency", async () => {
    const r = await chat("What do you know about me?");
    expect(r.toolCalls[0]?.name).toBe("review_memory");
  });
});
