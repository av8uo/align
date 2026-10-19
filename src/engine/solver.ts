/**
 * Plan solver: turns an insight into concrete, reversible calendar changes.
 * Deterministic and constraint-respecting:
 *  - only flexible events move; locked meetings are never touched
 *  - new blocks use genuinely free time (checked against existing AND proposed)
 *  - slot placement honors stated preferences (mornings personal/health, evenings family)
 *  - every candidate change is weighted by learned priors (acceptance × success)
 */
import type { DatabaseSync } from "node:sqlite";
import type { EventRow, GoalRow } from "../core/types.js";
import { newId } from "../core/ids.js";
import { goalActual, keywordOf } from "./detectors.js";
import { acceptancePrior, successPrior, changeKind, type Change } from "./learn.js";
import { addDays, at, overlaps, toMs } from "./time.js";

const pad = (n: number) => String(n).padStart(2, "0");
function fromMs(ms: number): string {
  const t = new Date(ms);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00`;
}

interface SlotTemplate {
  days: number[]; // offsets from `today` (0 = Monday of this week)
  sh: number; sm: number; eh: number; em: number;
  count: number;
}

/** Where a goal's sessions belong, per the user's stated preferences. */
function slotTemplate(goal: GoalRow): SlotTemplate {
  const t = goal.title.toLowerCase();
  if (goal.domain === "family" && t.includes("date")) return { days: [4, 5, 3], sh: 19, sm: 0, eh: 22, em: 0, count: 1 };
  if (goal.domain === "family" && t.includes("call")) return { days: [5, 6], sh: 17, sm: 0, eh: 17, em: 30, count: 1 };
  if (goal.domain === "health") return { days: [0, 2, 4, 1, 3], sh: 7, sm: 0, eh: 8, em: 0, count: goal.cadence_per_week };
  // personal growth: mornings on weekdays
  return { days: [0, 1, 2, 3, 4], sh: 7, sm: 30, eh: 8, em: 0, count: goal.cadence_per_week };
}

function isFree(start: string, end: string, events: EventRow[], proposed: Change[]): boolean {
  const eventClash = events.some((e) => overlaps(start, end, e.start, e.end));
  const proposedClash = proposed.some((c) => {
    const s = c.op === "create" ? c.start! : c.to!.start;
    const e = c.op === "create" ? c.end! : c.to!.end;
    return overlaps(start, end, s, e);
  });
  return !eventClash && !proposedClash;
}

export interface ProposedPlan {
  id: string;
  insightId: string;
  title: string;
  changes: Array<Change & { kind: string; priorScore: number }>;
  tradeoffs: string;
  expectedBenefit: string;
  hypothesis: string | null;
}

export function proposePlan(db: DatabaseSync, insightId: string, today: string): ProposedPlan {
  const insight = db.prepare("SELECT * FROM insights WHERE id = ?").get(insightId) as
    | { id: string; domains: string; evidence: string; title: string }
    | undefined;
  if (!insight) throw new Error(`Unknown insight: ${insightId}`);

  const domains = new Set(JSON.parse(insight.domains) as string[]);
  const evidence = JSON.parse(insight.evidence) as { collisions?: Array<[string, string]> };
  const events = db.prepare("SELECT * FROM events").all() as unknown as EventRow[];
  const goals = db.prepare("SELECT * FROM goals WHERE status='active'").all() as unknown as GoalRow[];
  const weekEnd = addDays(today, 7);
  const weekEvents = events.filter((e) => e.start >= `${today}T00:00:00` && e.start < `${weekEnd}T00:00:00`);

  const changes: Change[] = [];
  const moved: string[] = [];

  // 1) Resolve forward-scanned collisions by moving the flexible side earlier.
  for (const [workId, famId] of evidence.collisions ?? []) {
    const w = events.find((e) => e.id === workId);
    const f = events.find((e) => e.id === famId);
    if (!w || !f || w.flexible !== 1) continue;
    const duration = toMs(w.end) - toMs(w.start);
    const toEnd = toMs(f.start) - 30 * 60_000; // 30-min buffer before the family event
    const to = { start: fromMs(toEnd - duration), end: fromMs(toEnd) };
    if (!isFree(to.start, to.end, weekEvents.filter((e) => e.id !== w.id), changes)) continue;
    changes.push({ op: "move", domain: w.domain, title: w.title, event_id: w.id, from: { start: w.start, end: w.end }, to });
    moved.push(`"${w.title}" moves ${Math.round((toMs(w.start) - toMs(to.start)) / 60_000)} min earlier`);
  }

  // 2) Restore unmet goals inside this insight's domains with free-slot creates.
  const restored: string[] = [];
  for (const g of goals) {
    if (!domains.has(g.domain) || g.domain === "work" || g.domain === "finance") continue;
    const scheduled = goalActual(events, g, today, weekEnd);
    const needed = Math.max(g.cadence_per_week - scheduled, 0);
    if (needed === 0) continue;
    const tpl = slotTemplate(g);
    let placed = 0;
    for (const day of tpl.days) {
      if (placed >= Math.min(needed, tpl.count)) break;
      const start = at(today, day, tpl.sh, tpl.sm);
      const end = at(today, day, tpl.eh, tpl.em);
      if (!isFree(start, end, weekEvents, changes)) continue;
      changes.push({ op: "create", domain: g.domain, title: g.title, goalId: g.id, start, end });
      placed++;
    }
    if (placed > 0) restored.push(`${keywordOf(g.title)} ×${placed}`);
  }

  // 3) Weight every change by learned priors — the agent proposes what works for THIS person.
  const weighted = changes
    .map((c) => {
      const kind = changeKind(c);
      return { ...c, kind, priorScore: acceptancePrior(db, kind) * successPrior(db, kind) };
    })
    .filter((c) => c.priorScore >= 0.2);

  // Every plan is a measurable experiment: state the hypothesis up front,
  // measure it a week later (outcomes), report confirmed or refuted.
  const hypothesis =
    restored.length > 0
      ? `Protecting ${restored.join(", ")} this week lifts their adherence above last week's baseline.`
      : moved.length > 0
        ? `Resolving the schedule conflict prevents a missed family commitment this week.`
        : null;

  const plan: ProposedPlan = {
    id: newId("plan"),
    insightId,
    title: `Rebalance: ${restored.join(", ") || "resolve conflicts"}`,
    changes: weighted,
    tradeoffs: moved.length > 0 ? moved.join("; ") : "No locked meetings touched; new blocks use free time.",
    expectedBenefit: `Restores ${restored.join(", ")} this week${moved.length ? " and clears the schedule conflict" : ""}.`,
    hypothesis,
  };

  db.prepare(
    "INSERT INTO plans (id, insight_id, title, changes, tradeoffs, expected_benefit, hypothesis, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed')",
  ).run(plan.id, insightId, plan.title, JSON.stringify(plan.changes), plan.tradeoffs, plan.expectedBenefit, plan.hypothesis);
  return plan;
}
