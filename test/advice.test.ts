/**
 * "What would help" lines + the once-daily plan offer: grounded in goal
 * deficits and completion evidence, honest about missing data, no financial
 * advice, offered at most once per day across sessions/restarts, and never
 * applying anything (the consent gate is untouched).
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { migrate } from "../src/db/schema.js";
import { seed, DEMO_TODAY } from "../src/db/seed.js";
import { runEngine, loadCtx } from "../src/engine/engine.js";
import { lifeBalance } from "../src/engine/balance.js";
import { whatWouldHelp, dailyPlanOffer, kvGet } from "../src/engine/advice.js";
import { getDailyBriefing, checkIn } from "../src/tools/impl.js";
import { createLifeOsHttpServer } from "../src/server.js";
import { addDays } from "../src/engine/time.js";
import { proactiveInstruction, buildContext, renderContext } from "../src/sim/context.js";
import { newSession } from "../src/sim/orchestrator.js";

const fresh = () => { const db = new DatabaseSync(":memory:"); migrate(db); seed(db); runEngine(db, DEMO_TODAY); return db; };
const balanceOf = (db: DatabaseSync) => lifeBalance(loadCtx(db, DEMO_TODAY));

describe("what would help", () => {
  it("targets the weakest areas with a step tied to the detected deficit, and labels the evidence basis", () => {
    const db = fresh();
    const lines = whatWouldHelp(db, DEMO_TODAY, balanceOf(db), 2);
    expect(lines.map((l) => l.domain)).toEqual(["finance", "family"]); // the two lowest scores on day 1 (0 and 6)
    const fam = lines.find((l) => l.domain === "family")!;
    expect(fam.basis).toBe("confirmed"); // seeded history carries completion evidence
    expect(fam.line).toMatch(/^Family: "date night" is 0 of 1 last week — a free slot (Thursday|Friday|Saturday) \d\d:\d\d this week would restore it\.$/);
    expect(fam.goal_id).toBe("goal_date");
  });

  it("finance with nothing logged ASKS for the number — no advice, no invented amounts", () => {
    const db = fresh();
    const fin = whatWouldHelp(db, DEMO_TODAY, balanceOf(db), 2).find((l) => l.domain === "finance")!;
    expect(fin.basis).toBe("missing");
    expect(fin.line).toMatch(/nothing logged yet .* tell me what went in and I'll check your pace\.$/);
    expect(fin.line).not.toMatch(/should|invest|cut|save more|budget/i);
  });

  it("finance with a log reports the user's own numbers and the steady-pace figure only", () => {
    const db = fresh();
    checkIn(db, DEMO_TODAY, { content: "I put in 100", goal_id: "goal_house", amount: 100 }); // behind pace → finance still a weak area
    const fin = whatWouldHelp(db, DEMO_TODAY, balanceOf(db), 6).find((l) => l.domain === "finance")!;
    expect(fin.basis).toBe("confirmed");
    expect(fin.line).toMatch(/\$100 of \$500 logged .*; a steady pace would be at about \$306 by today\./); // 500 × 19/31
    // On pace → no longer a weak area → no line (nothing to fix is not advice).
    checkIn(db, DEMO_TODAY, { content: "I put in 250", goal_id: "goal_house", amount: 250 });
    expect(whatWouldHelp(db, DEMO_TODAY, balanceOf(db), 6).find((l) => l.domain === "finance")).toBeUndefined();
  });

  it("scheduled-but-unconfirmed sessions are reported as unconfirmed, never as done", () => {
    const db = fresh();
    // Put gym sessions on last week's calendar with no completion evidence; a higher target keeps health a weak area.
    db.prepare("UPDATE goals SET cadence_per_week=5 WHERE id='goal_gym'").run();
    for (let i = 0; i < 2; i++) db.prepare("INSERT INTO events (id, person_id, title, start, end, domain, flexible, source, reschedule_count, completion) VALUES (?, 'alex', 'Gym', ?, ?, 'health', 1, 'lifeos_plan', 0, 'scheduled')").run(`evt_u${i}`, `${addDays(DEMO_TODAY, -6 + i)}T18:00:00`, `${addDays(DEMO_TODAY, -6 + i)}T19:00:00`);
    const health = whatWouldHelp(db, DEMO_TODAY, balanceOf(db), 6).find((l) => l.domain === "health")!;
    expect(health.basis).toBe("scheduled");
    expect(health.line).toMatch(/1 confirmed of 5 last week \(2 on the calendar but unconfirmed\)/);
  });

  it("an area without a goal says there is nothing to measure — no invented cause", () => {
    const db = fresh();
    db.prepare("UPDATE goals SET status='paused' WHERE domain='household'").run();
    const lines = whatWouldHelp(db, DEMO_TODAY, [{ domain: "household", score: 10, trend: "flat", freshnessDays: 9, note: "" }], 2);
    expect(lines).toEqual([{ domain: "household", line: "Household: no goal set, so I have nothing to measure here.", basis: "missing" }]);
  });

  it("the briefing carries the lines and keeps them compact (at most two)", () => {
    const db = fresh();
    const b = getDailyBriefing(db, DEMO_TODAY);
    const help = (b.data as { help: Array<{ domain: string }> }).help;
    expect(help.length).toBeLessThanOrEqual(2);
    expect(b.text).toContain("What would help: Finance: nothing logged yet");
  });
});

describe("proactive instruction to the host model", () => {
  it("lists every engine-supplied 'what would help' step with its evidence and forbids added advice", () => {
    const db = fresh();
    const b = getDailyBriefing(db, DEMO_TODAY);
    const help = (b.data as { help: Array<{ line: string }> }).help;
    expect(help.length).toBe(2);
    const instruction = proactiveInstruction(b.text, help);
    for (const h of help) expect(instruction).toContain(`- ${h.line}`);
    expect(instruction).toMatch(/Keep EACH of them, with its numbers and its specific step/);
    expect(instruction).toMatch(/do not add any advice or step that is not listed below/);
    expect(instruction).toContain(b.text); // the computed briefing travels with it, unchanged
    // Without help lines, no step block is injected.
    expect(proactiveInstruction("Here's your briefing.", [])).not.toContain("next steps come from the engine");
  });
});

describe("next steps in the per-turn context", () => {
  it("the host context carries the engine's next steps with their evidence basis", () => {
    const db = fresh();
    const ctx = buildContext(db, newSession(), "how am I doing?", DEMO_TODAY);
    expect(ctx.nextSteps.length).toBe(2);
    expect(ctx.nextSteps.map((n) => n.domain)).toEqual(["finance", "family"]);
    const rendered = renderContext(ctx);
    expect(rendered).toContain("Best next steps right now");
    expect(rendered).toContain("[missing]");
    expect(rendered).toContain("[confirmed]");
  });
});

describe("once-daily plan offer", () => {
  it("is made once per day, persists across a server restart and sessions, and never applies anything", async () => {
    const db = fresh();
    const plansBefore = (db.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number }).n;
    const first = getDailyBriefing(db, DEMO_TODAY);
    expect(first.text).toContain('I have a plan ready — say "fix it".');
    expect((first.data as { plan_offered: boolean }).plan_offered).toBe(true);
    const second = getDailyBriefing(db, DEMO_TODAY);
    expect(second.text).not.toContain("I have a plan ready");
    expect(kvGet(db, "plan_offered_on")).toBe(DEMO_TODAY);
    // Restart: a new HTTP server on the same database, a new session.
    const server = createLifeOsHttpServer(db, DEMO_TODAY);
    await new Promise<void>((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const r = (await (await fetch(`${base}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: "other", text: "How's my week looking?" }) })).json()) as { reply: string };
    server.close();
    expect(r.reply).not.toContain("I have a plan ready");
    // Next day: offered again.
    expect(dailyPlanOffer(db, addDays(DEMO_TODAY, 1))).toContain("fix it");
    // Consent gate untouched: offering created no plan and applied nothing.
    expect((db.prepare("SELECT COUNT(*) AS n FROM plans").get() as { n: number }).n).toBe(plansBefore);
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE source='lifeos_plan'").get() as { n: number }).n).toBe(0);
  });

  it("is not made when no insight is actionable", () => {
    const db = fresh();
    db.prepare("UPDATE insights SET status='dismissed'").run();
    expect(dailyPlanOffer(db, DEMO_TODAY)).toBe("");
    expect(kvGet(db, "plan_offered_on")).toBeNull();
  });
});
