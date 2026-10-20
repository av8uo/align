/**
 * The learning loop — what makes Align smarter about this person every week.
 *
 * Two priors, both computed from REAL history (Laplace-smoothed):
 *  - acceptancePrior(kind): how often this person approves this kind of change
 *  - successPrior(kind):    how often this kind of change actually improved the metric
 * measureOutcomes() writes the ground truth those priors learn from.
 */
import type { DatabaseSync } from "node:sqlite";
import type { EventRow, GoalRow } from "../core/types.js";
import { newId } from "../core/ids.js";
import { goalActual, keywordOf } from "./detectors.js";
import { addDays } from "./time.js";

export interface Change {
  op: "create" | "move";
  domain: string;
  title: string;
  goalId?: string;
  event_id?: string;
  start?: string;
  end?: string;
  from?: { start: string; end: string };
  to?: { start: string; end: string };
}

export const changeKind = (c: Change): string => `${c.op}:${c.domain}`;

/** P(user approves | change kind), from plan history. Unknown kind -> 0.5. */
export function acceptancePrior(db: DatabaseSync, kind: string): number {
  const plans = db.prepare("SELECT changes, status FROM plans").all() as Array<{ changes: string; status: string }>;
  let accepted = 0;
  let decided = 0;
  for (const p of plans) {
    const kinds = (JSON.parse(p.changes) as Change[]).map(changeKind);
    if (!kinds.includes(kind)) continue;
    if (["approved", "executed", "verified"].includes(p.status)) {
      accepted++;
      decided++;
    } else if (p.status === "rejected") {
      decided++;
    }
  }
  return (accepted + 1) / (decided + 2);
}

/** P(change improves the metric | kind), from measured outcomes. Unknown -> 0.7 prior. */
export function successPrior(db: DatabaseSync, kind: string): number {
  if (!kind.startsWith("create:")) return 0.7;
  const domain = kind.slice("create:".length);
  const rows = db.prepare("SELECT verdict FROM outcomes WHERE metric = ?").all(`${domain}_adherence`) as Array<{
    verdict: string;
  }>;
  const scores = rows.map((r) => (r.verdict === "improved" ? 1 : r.verdict === "unchanged" ? 0.5 : 0));
  return (0.7 * 2 + scores.reduce((a: number, b) => a + b, 0)) / (2 + scores.length);
}

/**
 * Measure every executed plan whose follow-up window has begun:
 * compare goal adherence the week after execution vs the week before.
 * MVP ground truth = the calendar (scheduled counts as done; check-ins can override later).
 */
export function measureOutcomes(db: DatabaseSync, today: string): Array<{ metric: string; verdict: string }> {
  const plans = db
    .prepare("SELECT id, changes, executed_at FROM plans WHERE status IN ('executed','verified')")
    .all() as Array<{ id: string; changes: string; executed_at: string }>;
  const events = db.prepare("SELECT * FROM events").all() as unknown as EventRow[];
  const goals = db.prepare("SELECT * FROM goals").all() as unknown as GoalRow[];
  const measured: Array<{ metric: string; verdict: string }> = [];

  for (const p of plans) {
    const execDate = p.executed_at.slice(0, 10);
    if (today <= execDate) continue; // follow-up window not started
    const already = db.prepare("SELECT COUNT(*) AS n FROM outcomes WHERE plan_id = ?").get(p.id) as { n: number };
    if (already.n > 0) continue;

    const changes = JSON.parse(p.changes) as Change[];
    const seen = new Set<string>();
    for (const c of changes) {
      if (c.op !== "create" || !c.goalId || seen.has(c.goalId)) continue;
      seen.add(c.goalId);
      const goal = goals.find((g) => g.id === c.goalId);
      if (!goal) continue;
      const baseline = goalActual(events, goal, addDays(execDate, -7), execDate);
      const observed = goalActual(events, goal, execDate, addDays(execDate, 7));
      const verdict = observed > baseline ? "improved" : observed === baseline ? "unchanged" : "worse";
      db.prepare(
        "INSERT INTO outcomes (id, plan_id, metric, baseline, observed, measured_at, verdict) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(newId("out"), p.id, `${goal.domain}_adherence`, baseline, observed, today, verdict);
      measured.push({ metric: `${goal.domain}_adherence (${keywordOf(goal.title)})`, verdict });
    }
    db.prepare("UPDATE plans SET status='verified' WHERE id=?").run(p.id);
  }
  return measured;
}
