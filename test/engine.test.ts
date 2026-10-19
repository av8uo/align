/**
 * End-to-end engine test: the full demo loop —
 * detect → correlate → ask → answer → plan → apply (verified) → measure → learn.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db/schema.js";
import { seed, DEMO_TODAY } from "../src/db/seed.js";
import { runEngine, type EngineSummary } from "../src/engine/engine.js";
import { markAsked, recordAnswer } from "../src/engine/inquiry.js";
import { proposePlan, type ProposedPlan } from "../src/engine/solver.js";
import { applyPlan } from "../src/engine/executor.js";
import { measureOutcomes, successPrior, acceptancePrior } from "../src/engine/learn.js";

let db: DatabaseSync;
let first: EngineSummary;

function composite(): { id: string; domains: string[]; evidence: Record<string, unknown>; confidence: number } {
  const row = db
    .prepare("SELECT id, domains, evidence, confidence FROM insights WHERE title LIKE 'Work is crowding%'")
    .get() as { id: string; domains: string; evidence: string; confidence: number };
  expect(row).toBeTruthy();
  return { id: row.id, domains: JSON.parse(row.domains), evidence: JSON.parse(row.evidence), confidence: row.confidence };
}

beforeAll(() => {
  db = new DatabaseSync(":memory:");
  migrate(db);
  seed(db);
  first = runEngine(db, DEMO_TODAY);
});

describe("engine: detect + correlate", () => {
  it("produces the cross-domain composite insight", () => {
    const c = composite();
    for (const d of ["work", "family", "personal", "health"]) expect(c.domains).toContain(d);
    expect(c.evidence.lateEvenings).toBe(4);
    expect((c.evidence.collisions as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("scores life balance: family starving, work overloaded", () => {
    const family = first.balance.find((b) => b.domain === "family")!;
    const work = first.balance.find((b) => b.domain === "work")!;
    expect(family.score).not.toBeNull();
    expect(family.score!).toBeLessThan(30);
    expect(work.note).toContain("late evenings");
  });

  it("asks the highest-EVI question: the marriage gap", () => {
    expect(first.question?.gapId).toBe("gap_marriage");
    expect(first.question?.text).toContain("Sam");
  });
});

describe("engine: answer -> memory", () => {
  it("records the answer, links it, and raises gap confidence", () => {
    markAsked(db, first.question!.id, `${DEMO_TODAY}T07:05:00`);
    const { memoryId } = recordAnswer(
      db, "alex", first.question!.id,
      "Honestly we barely talk, work is eating everything.",
      `${DEMO_TODAY}T07:05:30`,
    );
    const mem = db.prepare("SELECT * FROM memory_items WHERE id=?").get(memoryId) as { question_id: string };
    expect(mem.question_id).toBe(first.question!.id);
    const gap = db.prepare("SELECT confidence FROM knowledge_gaps WHERE id='gap_marriage'").get() as { confidence: number };
    expect(gap.confidence).toBe(0.9);
  });
});

describe("engine: plan -> verified execution", () => {
  let plan: ProposedPlan;

  it("proposes concrete, constraint-respecting changes", () => {
    plan = proposePlan(db, composite().id, DEMO_TODAY);
    const dateNight = plan.changes.find((c) => c.op === "create" && c.title.includes("Date night"));
    expect(dateNight?.start).toBe("2026-10-23T19:00:00"); // Friday evening
    expect(plan.changes.filter((c) => c.op === "create" && c.domain === "personal").length).toBe(2);
    const move = plan.changes.find((c) => c.op === "move");
    expect(move?.title).toBe("Client workshop");
    expect(move!.to!.end <= "2026-10-22T18:00:00").toBe(true); // ends before the recital
  });

  it("applies with per-change verification", () => {
    const res = applyPlan(db, plan.id, `${DEMO_TODAY}T07:06:00`);
    expect(res.allVerified).toBe(true);
    const unverified = db.prepare("SELECT COUNT(*) AS n FROM action_log WHERE verified=0").get() as { n: number };
    expect(unverified.n).toBe(0);
    const created = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE source='lifeos_plan' AND start >= '2026-10-19T00:00:00'")
      .get() as { n: number };
    expect(created.n).toBeGreaterThanOrEqual(6); // date night + 3 gym + 2 spanish + call mom = 7
  });

  it("re-run: collision resolved, composite updated in place, confidence rose with the new memory", () => {
    runEngine(db, DEMO_TODAY);
    const c = composite();
    expect((c.evidence.collisions as unknown[]).length).toBe(0);
    const dupes = db.prepare("SELECT COUNT(*) AS n FROM insights WHERE title LIKE 'Work is crowding%'").get() as { n: number };
    expect(dupes.n).toBe(1);
    expect(c.confidence).toBeGreaterThan(0.7); // the "work is eating everything" answer is now evidence
  });
});

describe("engine: measure -> learn (smarter every week)", () => {
  it("measures outcomes one week later and verdicts improve", () => {
    const measured = measureOutcomes(db, "2026-10-26");
    expect(measured.length).toBeGreaterThanOrEqual(4); // date, gym, spanish, mom
    expect(measured.every((m) => m.verdict === "improved")).toBe(true);
  });

  it("priors shift from measured history — the agent now trusts these plans more", () => {
    expect(successPrior(db, "create:family")).toBeGreaterThan(0.7);
    expect(acceptancePrior(db, "create:family")).toBeGreaterThan(0.5);
  });
});
