/**
 * Intelligence evaluation suite — fixed fixtures, deterministic engine.
 * Each block reports a measurable property; the summary at the end prints the
 * numbers so the README can quote actual results, not "tests pass".
 */
import { describe, it, expect, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db/schema.js";
import { seed, DEMO_TODAY } from "../src/db/seed.js";
import { loadCtx, runEngine } from "../src/engine/engine.js";
import { discoverGaps, findContradictions, partnerName, pickQuestion, scoreGap, syncGaps, ASK_THRESHOLD } from "../src/engine/gaps.js";
import { acceptance, effectiveness, measureOutcomes, recordCompletions, recordRejection, verdictFor } from "../src/engine/learn.js";
import { proposePlan, rankCandidates } from "../src/engine/solver.js";
import { applyPlan } from "../src/engine/executor.js";
import { correlate } from "../src/engine/correlate.js";
import { g6Trend, runDetectors } from "../src/engine/detectors.js";
import { remember, reviewMemory, parseCompletionAnswer, getDailyBriefing } from "../src/tools/impl.js";
import { addDays } from "../src/engine/time.js";
import { lifeBalance } from "../src/engine/balance.js";

const fresh = () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  seed(db);
  return db;
};
const WEEK2 = addDays(DEMO_TODAY, 7);
const metrics: Record<string, string> = {};

describe("1. dynamic knowledge discovery", () => {
  it("discovers gaps from rows (no seeded gaps), each with kind, evidence, importance and the decision it informs", () => {
    const db = fresh();
    runEngine(db, DEMO_TODAY);
    const gaps = discoverGaps(db, loadCtx(db, DEMO_TODAY));
    expect(gaps.length).toBeGreaterThan(0);
    for (const g of gaps) {
      expect(["unknown", "contradiction", "stale"]).toContain(g.kind);
      expect(Object.keys(g.evidence).length).toBeGreaterThan(0);
      expect(g.importance).toBeGreaterThan(0);
      expect(g.decisionRef).toMatch(/^(outcome|pacing|insight-confidence|balance|preference):/);
    }
    const stored = db.prepare("SELECT source FROM knowledge_gaps WHERE status='open'").all() as Array<{ source: string }>;
    expect(stored.every((s) => s.source === "engine")).toBe(true);
  });

  it("names the partner only from a stated fact — never invents one", () => {
    const db = fresh();
    expect(partnerName(loadCtx(db, DEMO_TODAY).memory)).toBe("Sam");
    db.prepare("UPDATE memory_items SET status='forgotten' WHERE kind='fact'").run();
    expect(partnerName(loadCtx(db, DEMO_TODAY).memory)).toBeNull();
    const gaps = discoverGaps(db, loadCtx(db, DEMO_TODAY));
    const fam = gaps.find((g) => g.id === "gap_stale_family");
    expect(fam?.question).not.toContain("Sam");
  });

  it("distinguishes a contradiction from an unknown, and asks instead of guessing", () => {
    const db = fresh();
    remember(db, DEMO_TODAY, "Actually, I hate morning gym", "preference"); // vs seeded "Felt great after morning gym sessions"
    const ctx = loadCtx(db, DEMO_TODAY);
    const conflicts = findContradictions(ctx.memory, ctx.goals);
    expect(conflicts.map((c) => c.goal.id)).toEqual(["goal_gym"]);
    const gap = discoverGaps(db, ctx).find((g) => g.kind === "contradiction");
    expect(gap?.id).toBe("gap_conflict_goal_gym");
    expect(gap?.question).toMatch(/which should I plan around\?$/);
    expect((gap?.evidence as { memoryIds: string[] }).memoryIds.length).toBe(2);
  });

  it("never repeats an answered question and respects the one-per-week cooldown per gap", () => {
    const db = fresh();
    const first = runEngine(db, DEMO_TODAY);
    expect(first.question?.gapId).toBe("gap_stale_family");
    db.prepare("UPDATE questions SET status='asked', asked_at=? WHERE id=?").run(`${DEMO_TODAY}T08:00:00`, first.question!.id);
    db.prepare("UPDATE knowledge_gaps SET last_asked_at=? WHERE id='gap_stale_family'").run(`${DEMO_TODAY}T08:00:00`);
    const second = runEngine(db, addDays(DEMO_TODAY, 2));
    expect(second.question?.gapId).not.toBe("gap_stale_family");
  });
});

describe("3. decision-aware questioning", () => {
  it("a high-leverage question outranks a low-leverage one, and sensitivity zeroes a question", () => {
    const high = { importance: 0.9, uncertainty: 1, leverage: 1, burden: 0.1, sensitive: false };
    const low = { importance: 0.9, uncertainty: 1, leverage: 0.2, burden: 0.1, sensitive: false };
    expect(scoreGap(high)).toBeGreaterThan(scoreGap(low));
    expect(scoreGap({ ...high, sensitive: true })).toBe(0);
    expect(scoreGap(high, 1)).toBeLessThan(scoreGap(high, 0)); // declines cost
    expect(scoreGap(high, 0, 2)).toBeLessThan(scoreGap(high, 0, 7)); // cooldown ramps back over a week
  });

  it("asks NO question when no answer would materially change a decision", () => {
    const db = fresh();
    const first = runEngine(db, DEMO_TODAY);
    expect(first.question).not.toBeNull();
    // Resolve the family gap by answering; finance progress stays unknown but its leverage is low on day 19.
    db.prepare("UPDATE questions SET status='answered' WHERE id=?").run(first.question!.id);
    db.prepare("UPDATE knowledge_gaps SET status='resolved', last_asked_at=? WHERE id='gap_stale_family'").run(`${DEMO_TODAY}T08:00:00`);
    const second = runEngine(db, DEMO_TODAY);
    expect(second.question).toBeNull();
    const finance = discoverGaps(db, loadCtx(db, DEMO_TODAY)).find((g) => g.id === "gap_progress_goal_house")!;
    expect(scoreGap(finance)).toBeLessThan(ASK_THRESHOLD);
  });

  it("after a plan runs, the completion question (leverage 1) outranks everything else", () => {
    const db = fresh();
    const r = runEngine(db, DEMO_TODAY);
    const plan = proposePlan(db, r.insightIds[0]!, DEMO_TODAY);
    applyPlan(db, plan.id, `${DEMO_TODAY}T09:00:00`);
    const w2 = runEngine(db, WEEK2);
    expect(w2.question?.gapId).toMatch(/^gap_completion_/);
    const gaps = discoverGaps(db, loadCtx(db, WEEK2));
    const top = [...gaps].sort((a, b) => scoreGap(b) - scoreGap(a))[0]!;
    expect(top.leverage).toBe(1);
    metrics["question_usefulness"] = `${gaps.filter((g) => scoreGap(g) >= ASK_THRESHOLD).length} of ${gaps.length} discovered gaps worth asking on week 2; top = ${top.id}`;
  });
});

describe("2. evidence-grounded insights", () => {
  it("every surfaced insight exposes records, window, stated vs inferred, alternatives, missing, would_change", () => {
    const db = fresh();
    runEngine(db, DEMO_TODAY);
    const rows = db.prepare("SELECT title, evidence, status, confidence FROM insights").all() as Array<{ title: string; evidence: string; status: string; confidence: number }>;
    const surfaced = rows.filter((r) => r.status !== "weak");
    expect(surfaced.length).toBeGreaterThan(0);
    for (const r of surfaced) {
      const e = JSON.parse(r.evidence);
      expect(Array.isArray(e.records)).toBe(true);
      expect(e.records.length).toBeGreaterThan(0);
      expect(Array.isArray(e.stated) && Array.isArray(e.inferred)).toBe(true);
      expect(Array.isArray(e.alternatives) && Array.isArray(e.missing)).toBe(true);
      expect(typeof e.would_change).toBe("string");
    }
    const composite = surfaced.find((r) => r.title.startsWith("Work is crowding"))!;
    const e = JSON.parse(composite.evidence);
    expect(e.records.some((x: { type: string }) => x.type === "event")).toBe(true);
    expect(e.window).not.toBeNull();
    expect(e.alternatives[0]).toMatch(/heavy work week|several recent weeks/);
    metrics["insight_precision"] = `${surfaced.length} surfaced / ${rows.length} total (${rows.length - surfaced.length} suppressed as weak)`;
  });

  it("the briefing exposes an evidence summary per insight (counts, never the raw dump)", () => {
    const db = fresh();
    const b = getDailyBriefing(db, DEMO_TODAY);
    const top = (b.data as { insights: Array<{ title: string; confidence: number; evidence_summary: { events: number; goals: number; stated: number; alternatives: number } }> }).insights[0]!;
    expect(top.title).toMatch(/^Work is crowding/);
    expect(top.evidence_summary.events).toBeGreaterThan(0);
    expect(top.evidence_summary.goals).toBeGreaterThan(0);
    expect(top.evidence_summary.alternatives).toBeGreaterThan(0);
    expect(top.confidence).toBeLessThan(0.75);
  });

  it("does not claim causation from co-occurrence", () => {
    const db = fresh();
    runEngine(db, DEMO_TODAY);
    const row = db.prepare("SELECT reasoning FROM insights WHERE title LIKE 'Work is crowding%'").get() as { reasoning: string };
    expect(row.reasoning).toContain("can't prove one causes the other");
    expect(row.reasoning).not.toMatch(/\bbecause\b|\bcaused\b/);
  });

  it("suppresses a weak finding (no recorded history) instead of speaking it", () => {
    const db = fresh();
    db.prepare("INSERT INTO goals (id, person_id, domain, title, cadence_per_week, status, created_at) VALUES ('goal_new','alex','personal','Piano practice',2,'active',?)").run(`${DEMO_TODAY}T09:00:00`);
    runEngine(db, DEMO_TODAY);
    const row = db.prepare("SELECT status, confidence FROM insights WHERE title LIKE 'No \"Piano practice\"%'").get() as { status: string; confidence: number };
    expect(row.status).toBe("weak");
    expect(row.confidence).toBeLessThan(0.6);
    const surfacedTitles = (db.prepare("SELECT title FROM insights WHERE status IN ('new','surfaced')").all() as Array<{ title: string }>).map((r) => r.title);
    expect(surfacedTitles.some((t) => t.includes("Piano"))).toBe(false);
  });

  it("false-positive check: a balanced week with no late evenings produces no composite insight", () => {
    const db = fresh();
    db.prepare("UPDATE events SET end = substr(start,1,11) || '17:30:00' WHERE domain='work' AND start >= ? AND start < ?").run(`${addDays(DEMO_TODAY, -7)}T00:00:00`, `${DEMO_TODAY}T00:00:00`);
    const drafts = correlate(loadCtx(db, DEMO_TODAY), runDetectors(loadCtx(db, DEMO_TODAY)));
    expect(drafts.some((d) => d.title.startsWith("Work is crowding"))).toBe(false);
  });
});

describe("4. honest outcome measurement", () => {
  it("verdict rules: unknown is neither success nor failure", () => {
    expect(verdictFor(1, { scheduled: 3, confirmed: 0, missed: 0, unknown: 3 })).toBe("inconclusive");
    expect(verdictFor(null, { scheduled: 3, confirmed: 2, missed: 1, unknown: 0 })).toBe("inconclusive"); // no baseline
    expect(verdictFor(1, { scheduled: 3, confirmed: 2, missed: 0, unknown: 1 })).toBe("improved");
    expect(verdictFor(1, { scheduled: 3, confirmed: 1, missed: 0, unknown: 2 })).toBe("inconclusive"); // too little known to call it unchanged
    expect(verdictFor(1, { scheduled: 3, confirmed: 1, missed: 2, unknown: 0 })).toBe("unchanged");
    expect(verdictFor(2, { scheduled: 3, confirmed: 1, missed: 2, unknown: 0 })).toBe("worse");
    expect(verdictFor(0, { scheduled: 0, confirmed: 0, missed: 0, unknown: 0 })).toBe("inconclusive");
  });

  it("positive, negative and inconclusive outcomes from the same fixture, driven only by evidence", () => {
    const db = fresh();
    const r = runEngine(db, DEMO_TODAY);
    const plan = proposePlan(db, r.insightIds[0]!, DEMO_TODAY);
    applyPlan(db, plan.id, `${DEMO_TODAY}T09:00:00`);
    const before = measureOutcomes(db, WEEK2);
    expect(before.every((m) => m.verdict === "inconclusive")).toBe(true);
    recordCompletions(db, WEEK2, [{ goal_id: "goal_date", status: "done" }], `${WEEK2}T08:00:00`); // positive
    recordCompletions(db, WEEK2, [{ goal_id: "goal_gym", status: "missed", count: 3 }], `${WEEK2}T08:00:00`); // negative (baseline 1)
    const after = measureOutcomes(db, WEEK2);
    const v = (p: string) => after.find((m) => m.metric.startsWith(p))?.verdict;
    expect(v("family_adherence (date")).toBe("improved");
    expect(v("health")).toBe("worse");
    expect(v("personal")).toBe("inconclusive");
    const rows = db.prepare("SELECT metric, baseline, confirmed, missed, unknown, data_completeness FROM outcomes").all() as Array<Record<string, number | string>>;
    const complete = rows.filter((x) => Number(x.data_completeness) === 1).length;
    metrics["outcome_data_completeness"] = `${complete} of ${rows.length} metrics fully confirmed after check-ins; health baseline=${rows.find((x) => String(x.metric).startsWith("health"))!.baseline}`;
  });

  it("a statement about a named day corrects an imported record, and the balance score moves", () => {
    const db = fresh();
    const before = lifeBalance(loadCtx(db, DEMO_TODAY)).find((b) => b.domain === "health")!.score!;
    const marked = recordCompletions(db, DEMO_TODAY, [{ title: "gym", status: "missed", day: "Friday" }], `${DEMO_TODAY}T08:00:00`);
    expect(marked.length).toBe(1);
    expect(db.prepare("SELECT completion, completion_source FROM events WHERE id=?").get(marked[0]!)).toEqual({ completion: "missed", completion_source: "user_said" });
    expect(lifeBalance(loadCtx(db, DEMO_TODAY)).find((b) => b.domain === "health")!.score!).toBeLessThan(before);
    // Without a named day, imported history is left alone.
    expect(recordCompletions(fresh(), DEMO_TODAY, [{ title: "gym", status: "missed" }], `${DEMO_TODAY}T08:00:00`).length).toBe(0);
    // A user statement is never overwritten by a later contradictory one for the same event.
    expect(recordCompletions(db, DEMO_TODAY, [{ title: "gym", status: "done", day: "Friday" }], `${DEMO_TODAY}T09:00:00`).length).toBe(0);
  });

  it("the spoken answer to a completion question only marks what was said; ambiguity stays unknown", () => {
    expect(parseCompletionAnswer("Yes, we did!", 1)).toEqual({ done: 1, missed: 0 });
    expect(parseCompletionAnswer("No, it fell through", 1)).toEqual({ done: 0, missed: 1 });
    expect(parseCompletionAnswer("I made it twice", 3)).toEqual({ done: 2, missed: 1 });
    expect(parseCompletionAnswer("2 of 3", 3)).toEqual({ done: 2, missed: 1 });
    expect(parseCompletionAnswer("It was a strange week", 3)).toBeNull();
  });
});

describe("5. learning that changes decisions", () => {
  it("cold start: no history → prior with n=0, no candidate suppressed, preference breaks ties", () => {
    const db = fresh();
    const ctx = loadCtx(db, DEMO_TODAY);
    const gym = ctx.goals.find((g) => g.id === "goal_gym")!;
    const ranked = rankCandidates(db, gym, null, DEMO_TODAY, [], [], 3);
    expect(ranked.every((c) => c.effectiveness.n === 0 && !c.suppressed)).toBe(true);
    const pref = rankCandidates(db, gym, "evening", DEMO_TODAY, [], [], 3);
    expect(pref[0]!.kind).toBe("create:health:evening");
    expect(pref[0]!.preferred).toBe(true);
  });

  it("credible outcomes change the ranking: skipped mornings + done evenings → evening gym without any stated preference", () => {
    const db = fresh();
    // History: a plan created morning gym that was missed and evening gym that was done.
    db.prepare("INSERT INTO plans (id, insight_id, title, changes, status, executed_at) VALUES ('plan_h','ins_x','hist','[]','verified',?)").run(`${addDays(DEMO_TODAY, -14)}T09:00:00`);
    const ins = db.prepare("INSERT INTO events (id, person_id, title, start, end, domain, flexible, source, reschedule_count, completion, completion_source) VALUES (?, 'alex', 'Gym', ?, ?, 'health', 1, 'lifeos_plan', 0, ?, 'user_said')");
    for (let i = 0; i < 4; i++) ins.run(`evt_m${i}`, `${addDays(DEMO_TODAY, -13 + i)}T07:00:00`, `${addDays(DEMO_TODAY, -13 + i)}T08:00:00`, "missed");
    for (let i = 0; i < 4; i++) ins.run(`evt_e${i}`, `${addDays(DEMO_TODAY, -13 + i)}T18:00:00`, `${addDays(DEMO_TODAY, -13 + i)}T19:00:00`, "done");
    const morning = effectiveness(db, "create:health:morning");
    const evening = effectiveness(db, "create:health:evening");
    expect(morning.n).toBe(4);
    expect(evening.n).toBe(4);
    expect(evening.mean).toBeGreaterThan(morning.mean);
    expect(morning.lower).toBeLessThan(0.2); // 4 misses → suppressible
    const ctx = loadCtx(db, DEMO_TODAY);
    const gym = ctx.goals.find((g) => g.id === "goal_gym")!;
    const ranked = rankCandidates(db, gym, null, DEMO_TODAY, [], [], 3);
    expect(ranked[0]!.kind).toBe("create:health:evening");
    expect(ranked.find((c) => c.kind === "create:health:morning")?.suppressed).toBe(true);
    metrics["ranking_change"] = `health: morning mean ${morning.mean.toFixed(2)} (n=${morning.n}, lower ${morning.lower.toFixed(2)}) vs evening ${evening.mean.toFixed(2)} (n=${evening.n}) → evening chosen, morning suppressed`;
  });

  it("small samples stay humble: one success moves the estimate only partway", () => {
    const db = fresh();
    db.prepare("INSERT INTO events (id, person_id, title, start, end, domain, flexible, source, reschedule_count, completion) VALUES ('evt_one','alex','Gym',?,?,'health',1,'lifeos_plan',0,'done')").run(`${addDays(DEMO_TODAY, -3)}T18:00:00`, `${addDays(DEMO_TODAY, -3)}T19:00:00`);
    const e = effectiveness(db, "create:health:evening");
    expect(e.n).toBe(1);
    expect(e.mean).toBeCloseTo((0.6 * 2 + 1) / 3, 5);
    expect(e.lower).toBeLessThan(e.mean);
  });

  it("missing outcomes never become failures; rejection is recorded as acceptance evidence", () => {
    const db = fresh();
    const r = runEngine(db, DEMO_TODAY);
    const plan = proposePlan(db, r.insightIds[0]!, DEMO_TODAY);
    applyPlan(db, plan.id, `${DEMO_TODAY}T09:00:00`);
    measureOutcomes(db, WEEK2); // all inconclusive
    const kind = "create:family:evening";
    expect(effectiveness(db, kind).n).toBe(0); // inconclusive excluded
    const plan2 = proposePlan(db, r.insightIds[0]!, WEEK2);
    expect(recordRejection(db, plan2.id)).toBe(true);
    const acc = acceptance(db, kind);
    expect(acc.n).toBe(2); // one approved (plan 1) + one rejected (plan 2)
    expect(acc.mean).toBeCloseTo((0.5 * 2 + 1 + 0) / 4, 5);
  });
});

describe("6. longitudinal reasoning", () => {
  it("G6 trend needs three weeks of data and a monotone direction", () => {
    const db = fresh();
    const ctx = loadCtx(db, DEMO_TODAY);
    const t = g6Trend(ctx);
    expect(t.map((f) => f.evidence.goalId)).toEqual(expect.arrayContaining(["goal_spanish", "goal_mom"]));
    for (const f of t) expect((f.evidence.weeklyAdherence as number[]).length).toBe(3);
    // One bad week on an otherwise steady goal is NOT a trend: remove two weeks of history for gym.
    db.prepare("DELETE FROM events WHERE title='Gym' AND start < ?").run(`${addDays(DEMO_TODAY, -7)}T00:00:00`);
    const t2 = g6Trend(loadCtx(db, DEMO_TODAY));
    expect(t2.some((f) => f.evidence.goalId === "goal_gym")).toBe(false);
  });

  it("an explicit correction supersedes the older preference and the planner follows the newer one", () => {
    const db = fresh();
    remember(db, DEMO_TODAY, "I hate morning gym", "preference");
    const r2 = remember(db, addDays(DEMO_TODAY, 1), "Actually I love morning gym now", "preference");
    expect(r2.text).toMatch(/^Updated — I'll go with this instead of/);
    const rows = db.prepare("SELECT content, status, supersedes_id FROM memory_items WHERE kind='preference' AND content LIKE '%morning gym%' ORDER BY created_at").all() as Array<{ content: string; status: string; supersedes_id: string | null }>;
    expect(rows.map((x) => x.status)).toEqual(["corrected", "active"]);
    expect(rows[1]!.supersedes_id).toBeTruthy();
    expect(reviewMemory(db).text).not.toContain("I hate morning gym");
    const r = runEngine(db, addDays(DEMO_TODAY, 1));
    const plan = proposePlan(db, r.insightIds[0]!, DEMO_TODAY);
    const gym = plan.changes.filter((c) => c.title === "Gym");
    expect(gym.length).toBeGreaterThan(0);
    for (const g of gym) expect(g.start).toContain("T07:00");
  });

  it("a third-person paraphrase from an LLM host ('The user hates morning workouts.') is understood and supersedes/dedupes like the original", () => {
    const db = fresh();
    remember(db, DEMO_TODAY, "The user hates morning workouts.", "preference");
    const r = runEngine(db, DEMO_TODAY);
    const plan = proposePlan(db, r.insightIds[0]!, DEMO_TODAY);
    for (const g of plan.changes.filter((c) => c.title === "Gym")) expect(g.start).toContain("T18:00");
    const dup = remember(db, DEMO_TODAY, "User dislikes morning workouts; avoid scheduling gym in the morning.", "preference");
    expect(dup.data).toMatchObject({ duplicate: true });
    const flip = remember(db, addDays(DEMO_TODAY, 1), "The user now prefers morning workouts.", "preference");
    expect(flip.data.supersedes_id).toBeTruthy();
  });

  it("duplicate memories are not stored twice; equivalent phrasing dedupes", () => {
    const db = fresh();
    const a = remember(db, DEMO_TODAY, "Leo has football on Wednesdays.", "fact");
    const b = remember(db, DEMO_TODAY, "leo has football on wednesdays", "fact");
    expect(b.data).toMatchObject({ memory_id: a.data.memory_id, duplicate: true });
  });
});

describe("7. safety preserved", () => {
  it("a plan needs explicit approval; verification re-reads every write; nothing is fabricated", () => {
    const db = fresh();
    const r = runEngine(db, DEMO_TODAY);
    const plan = proposePlan(db, r.insightIds[0]!, DEMO_TODAY);
    expect(db.prepare("SELECT status FROM plans WHERE id=?").get(plan.id)).toEqual({ status: "proposed" });
    const res = applyPlan(db, plan.id, `${DEMO_TODAY}T09:00:00`);
    expect(res.allVerified).toBe(true);
    const created = db.prepare("SELECT completion FROM events WHERE source='lifeos_plan'").all() as Array<{ completion: string }>;
    expect(created.every((e) => e.completion === "scheduled")).toBe(true); // applied ≠ done
  });
});

afterAll(() => {
  console.log("\n=== intelligence eval metrics ===\n" + Object.entries(metrics).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n");
});
