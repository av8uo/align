/**
 * The proactive opening picks up the thread: what the user told Align and the
 * last plan applied are read back from the store, newest first.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db/schema.js";
import { seed, DEMO_TODAY } from "../src/db/seed.js";
import { runEngine } from "../src/engine/engine.js";
import { proposePlan } from "../src/engine/solver.js";
import { applyPlan } from "../src/engine/executor.js";
import { remember } from "../src/tools/impl.js";
import { addDays } from "../src/engine/time.js";
import { renderRecall, sinceLastTime } from "../src/sim/recall.js";
import { proactiveInstruction } from "../src/sim/context.js";

describe("since we last spoke", () => {
  it("recalls the user's own words and the applied plan; nothing for a seeded first day", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    seed(db);
    expect(renderRecall(sinceLastTime(db, DEMO_TODAY))).toBe(""); // imported history is not "something you told me"

    remember(db, DEMO_TODAY, "I hate morning gym", "preference");
    const r = runEngine(db, DEMO_TODAY);
    applyPlan(db, proposePlan(db, r.insightIds[0]!, DEMO_TODAY).id, `${DEMO_TODAY}T09:00:00`);

    const recall = sinceLastTime(db, addDays(DEMO_TODAY, 7));
    expect(recall.said.some((s) => /hate morning gym/i.test(s))).toBe(true);
    expect(recall.plan?.changes).toBeGreaterThan(0);
    const instruction = proactiveInstruction("briefing", [], renderRecall(recall));
    expect(instruction).toMatch(/picking up the thread/);
    expect(instruction).toContain("hate morning gym");
  });
});
