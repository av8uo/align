/**
 * Plan solver: turns an insight into concrete, reversible calendar changes.
 * Deterministic and constraint-respecting:
 *  - only flexible events move; locked meetings are never touched
 *  - new blocks use genuinely free time (checked against existing AND proposed)
 *  - slot placement honors stated preferences (mornings personal/health, evenings family)
 *  - every candidate slot is RANKED by learned estimates: effectiveness of this
 *    kind of change (did evening gym actually get done?) × acceptance, with the
 *    sample size kept visible; a kind is suppressed only once evidence says so
 */
import type { DatabaseSync } from "node:sqlite";
import type { EventRow, GoalRow } from "../core/types.js";
import { newId } from "../core/ids.js";
import { goalActual, keywordOf } from "./detectors.js";
import { acceptance, effectiveness, changeKind, type Change, type Estimate } from "./learn.js";
import { preferredTimeFor } from "./preferences.js";
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

/**
 * Learned time-of-day preference for a goal, from structured preferences
 * (src/engine/preferences.ts): "I hate morning workouts" and "mornings work
 * better now" are understood, not keyword-matched. This is how a spoken
 * correction visibly changes the NEXT plan.
 */
export function timePreferenceFor(
  goal: GoalRow,
  memories: Array<{ kind: string; content: string; status: string; created_at?: string }>,
): "morning" | "evening" | null {
  return preferredTimeFor(goal, memories);
}

/** Candidate slot families for a goal: the stated/learned preference first, the alternative second. */
function slotTemplates(goal: GoalRow, pref: "morning" | "evening" | null): SlotTemplate[] {
  const t = goal.title.toLowerCase();
  if (goal.domain === "family" && t.includes("date")) return [{ days: [4, 5, 3], sh: 19, sm: 0, eh: 22, em: 0, count: 1 }];
  if (goal.domain === "family" && t.includes("call")) return [{ days: [5, 6], sh: 17, sm: 0, eh: 17, em: 30, count: 1 }];
  if (goal.domain === "household") return [{ days: [5, 6, 2], sh: 10, sm: 0, eh: 11, em: 0, count: goal.cadence_per_week }];
  const n = goal.cadence_per_week;
  const health = {
    morning: { days: [0, 2, 4, 1, 3], sh: 7, sm: 0, eh: 8, em: 0, count: n },
    evening: { days: [0, 2, 4, 1, 3], sh: 18, sm: 0, eh: 19, em: 0, count: n },
  };
  const personal = {
    morning: { days: [0, 1, 2, 3, 4], sh: 7, sm: 30, eh: 8, em: 0, count: n },
    evening: { days: [0, 1, 2, 3, 4], sh: 20, sm: 30, eh: 21, em: 0, count: n },
  };
  const fam = goal.domain === "health" ? health : personal;
  // A stated preference is a hard constraint on the first choice; the other
  // time of day is still generated so learned evidence can be compared.
  return pref === "evening" ? [fam.evening, fam.morning] : pref === "morning" ? [fam.morning, fam.evening] : [fam.morning, fam.evening];
}

export interface RankedCandidate {
  change: Change;
  kind: string;
  score: number;
  effectiveness: Estimate;
  acceptance: Estimate;
  preferred: boolean;
  suppressed: boolean;
}

/**
 * Rank candidate slots for one goal. Score = effectiveness.mean × acceptance.mean,
 * ×1.5 when the slot matches a stated preference (what you said beats what we
 * guessed). A kind is suppressed only with evidence: lower bound < 0.2 and n ≥ 4.
 */
export function rankCandidates(db: DatabaseSync, goal: GoalRow, pref: "morning" | "evening" | null, today: string, weekEvents: EventRow[], proposed: Change[], needed: number): RankedCandidate[] {
  const out: RankedCandidate[] = [];
  const templates = slotTemplates(goal, pref);
  templates.forEach((tpl, i) => {
    const preferred = pref !== null && i === 0;
    let placed = 0;
    for (const day of tpl.days) {
      if (placed >= Math.min(needed, tpl.count)) break;
      const start = at(today, day, tpl.sh, tpl.sm);
      const end = at(today, day, tpl.eh, tpl.em);
      if (!isFree(start, end, weekEvents, proposed)) continue;
      const change: Change = { op: "create", domain: goal.domain, title: goal.title, goalId: goal.id, start, end };
      const kind = changeKind(change);
      const eff = effectiveness(db, kind);
      const acc = acceptance(db, kind);
      // Evidence can suppress a guessed slot, never a slot the user explicitly asked for.
      const suppressed = !preferred && eff.n >= 4 && eff.lower < 0.2;
      out.push({ change, kind, score: eff.mean * acc.mean * (preferred ? 1.5 : 1), effectiveness: eff, acceptance: acc, preferred, suppressed });
      placed++;
    }
  });
  return out.sort((a, b) => b.score - a.score);
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
  changes: Array<Change & { kind: string; priorScore: number; evidence_n: number }>;
  tradeoffs: string;
  expectedBenefit: string;
  hypothesis: string | null;
  /** How each goal's slot was chosen: the ranked kinds with their learned scores and sample sizes. */
  ranking: Array<{ goal: string; chosen: string; alternatives: Array<{ kind: string; score: number; n: number }> }>;
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
  const memories = db.prepare("SELECT kind, content, status, created_at FROM memory_items").all() as Array<{
    kind: string;
    content: string;
    status: string;
    created_at: string;
  }>;
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

  // 2) Restore unmet goals inside this insight's domains: generate candidate
  //    slots (preferred time of day first, the alternative second), rank them by
  //    learned effectiveness × acceptance, and take the best `needed` of them.
  const restored: string[] = [];
  const ranking: Array<{ goal: string; chosen: string; alternatives: Array<{ kind: string; score: number; n: number }> }> = [];
  for (const g of goals) {
    if (!domains.has(g.domain) || g.domain === "work" || g.domain === "finance") continue;
    const scheduled = goalActual(events, g, today, weekEnd);
    const needed = Math.max(g.cadence_per_week - scheduled, 0);
    if (needed === 0) continue;
    const candidates = rankCandidates(db, g, timePreferenceFor(g, memories), today, weekEvents, changes, needed).filter((c) => !c.suppressed);
    let placed = 0;
    for (const c of candidates) {
      if (placed >= needed) break;
      if (!isFree(c.change.start!, c.change.end!, weekEvents, changes)) continue;
      changes.push(c.change);
      placed++;
    }
    if (placed > 0) {
      restored.push(`${keywordOf(g.title)} ×${placed}`);
      const byKind = new Map<string, { score: number; n: number }>();
      for (const c of candidates) if (!byKind.has(c.kind)) byKind.set(c.kind, { score: Math.round(c.score * 100) / 100, n: c.effectiveness.n });
      ranking.push({ goal: g.id, chosen: candidates[0]!.kind, alternatives: [...byKind].map(([kind, v]) => ({ kind, ...v })) });
    }
  }

  // 3) Attach the learned estimates to every change so the plan is auditable.
  const weighted = changes.map((c) => {
    const kind = changeKind(c);
    const eff = effectiveness(db, kind);
    const acc = acceptance(db, kind);
    return { ...c, kind, priorScore: Math.round(eff.mean * acc.mean * 100) / 100, evidence_n: eff.n + acc.n };
  });

  // Every plan is a measurable experiment: state the hypothesis up front,
  // measure it a week later (outcomes), report confirmed or refuted.
  const hypothesis =
    restored.length > 0
      ? `Protecting ${restored.join(", ")} this week lifts their confirmed completions above last week's baseline.`
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
    ranking,
  };

  db.prepare(
    "INSERT INTO plans (id, insight_id, title, changes, tradeoffs, expected_benefit, hypothesis, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed')",
  ).run(plan.id, insightId, plan.title, JSON.stringify(plan.changes), plan.tradeoffs, plan.expectedBenefit, plan.hypothesis);
  return plan;
}
