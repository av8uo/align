/**
 * Life Balance moves on evidence, not on the calendar: an applied plan shows as
 * the "planned" level, the week passing makes unconfirmed sessions count half,
 * and the user's confirmation is what lifts the score.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db/schema.js";
import { seed, DEMO_TODAY } from "../src/db/seed.js";
import { loadCtx, runEngine } from "../src/engine/engine.js";
import { proposePlan } from "../src/engine/solver.js";
import { applyPlan } from "../src/engine/executor.js";
import { recordCompletions } from "../src/engine/learn.js";
import { lifeBalance } from "../src/engine/balance.js";
import { moneyTarget, currencyOf } from "../src/engine/detectors.js";
import { addDays } from "../src/engine/time.js";

const WEEK2 = addDays(DEMO_TODAY, 7);
const family = (db: DatabaseSync, day: string) => lifeBalance(loadCtx(db, day)).find((b) => b.domain === "family")!;

describe("life balance follows evidence", () => {
  it("plan → planned level; week passes → half credit; confirmation → full credit", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    seed(db);
    const start = family(db, DEMO_TODAY);
    expect(start.planned ?? 0).toBeLessThanOrEqual(start.score!); // nothing planned yet: no faint bar

    const r = runEngine(db, DEMO_TODAY);
    applyPlan(db, proposePlan(db, r.insightIds[0]!, DEMO_TODAY).id, `${DEMO_TODAY}T09:00:00`);
    const applied = family(db, DEMO_TODAY);
    expect(applied.score).toBe(start.score); // scheduled is not done
    expect(applied.planned!).toBeGreaterThan(applied.score!);

    const unconfirmed = family(db, WEEK2).score!;
    expect(unconfirmed).toBeGreaterThan(start.score!);
    expect(unconfirmed).toBeLessThan(90); // half credit, not a free 97

    recordCompletions(db, WEEK2, [{ goal_id: "goal_date", status: "done" }], `${WEEK2}T08:00:00`);
    expect(family(db, WEEK2).score!).toBeGreaterThan(unconfirmed);
  });

  it("reads money targets in any currency the user speaks", () => {
    expect(moneyTarget("$500/month house fund")).toBe(500);
    expect(moneyTarget("€300/month for Lina's studies")).toBe(300);
    expect(moneyTarget("Save 300 euros a month")).toBe(300);
    expect(moneyTarget("Read more")).toBe(0);
    expect(currencyOf("€300/month")).toBe("€");
    expect(currencyOf("300 euros")).toBe("€");
    expect(currencyOf("$500")).toBe("$");
  });
});
