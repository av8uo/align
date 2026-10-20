/**
 * Blank mind: Align meeting a brand-new user. With nothing recorded, the
 * proactive channel introduces the agent and opens the onboarding interview
 * instead of staying quiet, and the host context flags NEW USER.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { migrate } from "../src/db/schema.js";
import { seed, blankStart, DEMO_TODAY } from "../src/db/seed.js";
import { createLifeOsHttpServer } from "../src/server.js";
import { buildContext, renderContext } from "../src/sim/context.js";
import { newSession } from "../src/sim/orchestrator.js";

let server: ReturnType<typeof createLifeOsHttpServer>;
let base: string;
let db: DatabaseSync;

beforeAll(async () => {
  db = new DatabaseSync(":memory:");
  migrate(db);
  seed(db); // start SEEDED on purpose: /demo/fresh must wipe it
  server = createLifeOsHttpServer(db, DEMO_TODAY);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

describe("blank mind (new user) mode", () => {
  it("/demo/fresh wipes the life model down to an unnamed person", async () => {
    const r = (await (await fetch(`${base}/demo/fresh`, { method: "POST" })).json()) as { fresh: boolean };
    expect(r.fresh).toBe(true);
    const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(n("goals")).toBe(0);
    expect(n("memory_items")).toBe(0);
    expect(n("events")).toBe(0);
    expect(n("people")).toBe(1);
  });

  it("proactive opens the onboarding interview instead of staying quiet", async () => {
    const r = (await (await fetch(`${base}/proactive?session_id=new`)).json()) as {
      quiet: boolean;
      text: string;
      data: { onboarding?: boolean };
    };
    expect(r.quiet).toBe(false);
    expect(r.data.onboarding).toBe(true);
    expect(r.text).toMatch(/I'm Align/);
    expect(r.text).toMatch(/don't know you yet/);
    expect(r.text).toMatch(/review or delete/); // memory transparency, stated up front
  });

  it("the host context flags NEW USER so the LLM runs the interview", () => {
    const text = renderContext(buildContext(db, newSession(), "hi", DEMO_TODAY));
    expect(text).toContain("NEW USER: no goals, facts or preferences recorded yet");
  });

  it("after onboarding stores a goal and a fact, the flag disappears", () => {
    db.prepare(
      "INSERT INTO goals (id, person_id, domain, title, cadence_per_week, status, created_at) VALUES ('g1','alex','health','Gym',3,'active',?)",
    ).run(`${DEMO_TODAY}T08:00:00`);
    const text = renderContext(buildContext(db, newSession(), "hi", DEMO_TODAY));
    expect(text).not.toContain("NEW USER");
  });

  it("reset returns to the seeded persona", async () => {
    await fetch(`${base}/demo/reset`, { method: "POST" });
    const r = (await (await fetch(`${base}/proactive`)).json()) as { quiet: boolean; data: { onboarding?: boolean } };
    expect(r.data.onboarding).toBeUndefined();
    expect(r.quiet).toBe(false); // the seeded briefing speaks
  });
});
