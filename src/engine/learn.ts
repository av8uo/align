/**
 * The learning loop — honest version.
 *
 * Ground truth is COMPLETION EVIDENCE (events.completion = done | missed),
 * never "it was on the calendar". Unknown is neither success nor failure.
 *
 * Two learned estimates, both shrunk toward a cold-start prior with the sample
 * size kept visible (no overconfidence from n=1):
 *  - acceptance(kind): how often this person approves this kind of change
 *  - effectiveness(kind): how often this kind of change was actually completed
 *    / improved its metric, from measured outcomes (inconclusive ones excluded)
 * where kind = `create:<domain>:<morning|evening>` or `move:<domain>`, so the
 * agent can learn e.g. "evening gym gets done, morning gym gets skipped".
 */
import type { DatabaseSync } from "node:sqlite";
import type { EventRow, GoalRow } from "../core/types.js";
import { newId } from "../core/ids.js";
import { goalActual, goalEvents, keywordOf } from "./detectors.js";
import { addDays, minutesOf } from "./time.js";

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

export const timeOfDay = (iso: string): "morning" | "afternoon" | "evening" => {
  const m = minutesOf(iso);
  return m < 12 * 60 ? "morning" : m < 17 * 60 ? "afternoon" : "evening";
};

export const changeKind = (c: Change): string =>
  c.op === "create" ? `create:${c.domain}:${timeOfDay(c.start!)}` : `move:${c.domain}`;

/** A learned estimate with its evidence base. */
export interface Estimate {
  mean: number; // shrunk toward the prior
  n: number; // observations behind it
  prior: number;
  /** Conservative value: mean minus one standard error (cold start = prior - ~0.2). */
  lower: number;
}

const K = 2; // prior weight in pseudo-observations: n=2 real observations count as much as the prior

function estimate(prior: number, scores: number[]): Estimate {
  const n = scores.length;
  const mean = (prior * K + scores.reduce((a, b) => a + b, 0)) / (K + n);
  const se = Math.sqrt((mean * (1 - mean)) / (K + n)) || 0;
  return { mean, n, prior, lower: Math.max(0, mean - se) };
}

/** P(user approves | change kind), from decided plans. Cold start: 0.5. */
export function acceptance(db: DatabaseSync, kind: string): Estimate {
  const plans = db.prepare("SELECT changes, status FROM plans").all() as Array<{ changes: string; status: string }>;
  const scores: number[] = [];
  for (const p of plans) {
    const kinds = (JSON.parse(p.changes) as Change[]).map(changeKind);
    if (!kinds.includes(kind)) continue;
    if (["approved", "executed", "verified"].includes(p.status)) scores.push(1);
    else if (p.status === "rejected") scores.push(0);
  }
  return estimate(0.5, scores);
}

/**
 * P(this kind of change actually gets done | kind), from completion evidence on
 * events a plan created (done=1, missed=0, unknown excluded) plus outcome
 * verdicts (improved=1, unchanged=0.5, worse=0, inconclusive excluded).
 * Cold start: 0.6.
 */
export function effectiveness(db: DatabaseSync, kind: string): Estimate {
  const scores: number[] = [];
  if (kind.startsWith("create:")) {
    const [, domain = "", tod = ""] = kind.split(":");
    const rows = db
      .prepare("SELECT start, completion FROM events WHERE source='lifeos_plan' AND domain=? AND completion IN ('done','missed')")
      .all(domain) as Array<{ start: string; completion: string }>;
    for (const r of rows) if (timeOfDay(r.start) === tod) scores.push(r.completion === "done" ? 1 : 0);
    const outcomes = db
      .prepare("SELECT verdict FROM outcomes WHERE metric LIKE ? AND verdict IN ('improved','unchanged','worse')")
      .all(`${domain}_adherence%`) as Array<{ verdict: string }>;
    for (const o of outcomes) scores.push(o.verdict === "improved" ? 1 : o.verdict === "unchanged" ? 0.5 : 0);
  }
  return estimate(0.6, scores);
}

/** Backward-compatible scalar views (used by older call sites and tests). */
export const acceptancePrior = (db: DatabaseSync, kind: string): number => acceptance(db, kind).mean;
export const successPrior = (db: DatabaseSync, kind: string): number => effectiveness(db, kind).mean;

/** The user declined a proposed plan: that is acceptance evidence, recorded once. */
export function recordRejection(db: DatabaseSync, planId: string): boolean {
  const r = db.prepare("UPDATE plans SET status='rejected' WHERE id=? AND status='proposed'").run(planId);
  return r.changes > 0;
}

// ---------------------------------------------------------------- completion evidence
export interface CompletionReport {
  goal_id?: string;
  title?: string;
  status: "done" | "missed";
  /** Weekday name or YYYY-MM-DD; when omitted, the most recent unconfirmed occurrence is meant. */
  day?: string;
  count?: number;
}

/**
 * Apply user-reported completion evidence to past events (last 14 days).
 * Returns the event ids that were marked. Never touches events already marked.
 */
export function recordCompletions(db: DatabaseSync, today: string, reports: CompletionReport[], now: string, personId = "alex"): string[] {
  const events = db.prepare("SELECT * FROM events WHERE person_id=? AND start < ? AND start >= ?").all(personId, `${today}T23:59:59`, `${addDays(today, -14)}T00:00:00`) as unknown as EventRow[];
  const goals = db.prepare("SELECT * FROM goals WHERE person_id=?").all(personId) as unknown as GoalRow[];
  const marked: string[] = [];
  // What the user states outranks an imported assumption (seed), but never an
  // earlier statement of their own.
  const mark = db.prepare("UPDATE events SET completion=?, completion_source='user_said', completed_at=? WHERE id=? AND (completion IN ('scheduled','unknown') OR completion_source='seed')");
  for (const r of reports) {
    const goal = r.goal_id ? goals.find((g) => g.id === r.goal_id) : r.title ? goals.find((g) => keywordOf(g.title) === keywordOf(r.title!) || g.title.toLowerCase().includes(r.title!.toLowerCase())) : undefined;
    const kw = goal ? keywordOf(goal.title) : (r.title ?? "").toLowerCase();
    if (!kw) continue;
    // Skip events already marked, including ones marked earlier in this same call.
    // Without a named day only unconfirmed sessions qualify; with a named day an
    // imported (seed) record may be corrected too — the user is the authority on their own past.
    const correctable = (e: EventRow) => e.completion === "scheduled" || e.completion === "unknown" || (!!r.day && e.completion_source === "seed");
    let candidates = events.filter((e) => e.title.toLowerCase().includes(kw) && correctable(e) && !marked.includes(e.id));
    if (r.day) {
      const wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].indexOf(r.day.toLowerCase());
      candidates = candidates.filter((e) => (/^\d{4}-\d{2}-\d{2}$/.test(r.day!) ? e.start.startsWith(r.day!) : wd >= 0 && new Date(`${e.start}Z`).getUTCDay() === (wd + 1) % 7));
    }
    candidates.sort((a, b) => (a.start < b.start ? 1 : -1)); // most recent first
    for (const e of candidates.slice(0, r.count ?? 1)) {
      if (mark.run(r.status, now, e.id).changes > 0) marked.push(e.id);
    }
  }
  return marked;
}

// ---------------------------------------------------------------- outcome measurement
export interface OutcomeRow {
  plan_id: string;
  metric: string;
  baseline: number | null;
  observed: number | null;
  scheduled: number;
  confirmed: number;
  missed: number;
  unknown: number;
  data_completeness: number;
  verdict: "improved" | "unchanged" | "worse" | "inconclusive";
  window_start: string;
  window_end: string;
}

function countBy(events: EventRow[], g: GoalRow, from: string, to: string) {
  const inWin = goalEvents(events, g, from, to);
  const confirmed = inWin.filter((e) => e.completion === "done").length;
  const missed = inWin.filter((e) => e.completion === "missed").length;
  const unknown = inWin.length - confirmed - missed;
  return { scheduled: inWin.length, confirmed, missed, unknown };
}

/** The verdict rule, pure so it can be tested on its own. */
export function verdictFor(baseline: number | null, c: { scheduled: number; confirmed: number; missed: number; unknown: number }): OutcomeRow["verdict"] {
  const known = c.confirmed + c.missed;
  if (c.scheduled === 0 || known === 0) return "inconclusive";
  if (baseline === null) return "inconclusive";
  if (c.confirmed > baseline) return "improved"; // enough confirmed evidence regardless of unknowns
  const completeness = known / c.scheduled;
  if (completeness < 0.5) return "inconclusive"; // too much unknown to call it unchanged/worse
  return c.confirmed === baseline ? "unchanged" : "worse";
}

/**
 * Measure every applied plan whose follow-up window has begun. Re-measures
 * inconclusive outcomes while evidence can still arrive (≤14 days after the
 * window closes). Baseline = confirmed completions in the week before execution.
 */
export function measureOutcomes(db: DatabaseSync, today: string): Array<{ metric: string; verdict: string; unknown: number }> {
  const plans = db
    .prepare("SELECT id, changes, executed_at FROM plans WHERE status IN ('executed','verified')")
    .all() as Array<{ id: string; changes: string; executed_at: string }>;
  const events = db.prepare("SELECT * FROM events").all() as unknown as EventRow[];
  const goals = db.prepare("SELECT * FROM goals").all() as unknown as GoalRow[];
  const measured: Array<{ metric: string; verdict: string; unknown: number }> = [];
  const upsert = db.prepare(
    `INSERT INTO outcomes (id, plan_id, metric, baseline, observed, measured_at, verdict, scheduled, confirmed, missed, unknown, data_completeness, window_start, window_end, attribution)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'association')`,
  );
  const update = db.prepare(
    "UPDATE outcomes SET observed=?, measured_at=?, verdict=?, scheduled=?, confirmed=?, missed=?, unknown=?, data_completeness=? WHERE id=?",
  );

  for (const p of plans) {
    const execDate = p.executed_at.slice(0, 10);
    if (today <= execDate) continue; // follow-up window not started
    const winStart = execDate;
    const winEnd = addDays(execDate, 7);
    if (today > addDays(winEnd, 14)) continue; // evidence window closed; leave the stored verdict as is
    const changes = JSON.parse(p.changes) as Change[];
    const seen = new Set<string>();
    for (const c of changes) {
      if (c.op !== "create" || !c.goalId || seen.has(c.goalId)) continue;
      seen.add(c.goalId);
      const goal = goals.find((g) => g.id === c.goalId);
      if (!goal) continue;
      const metric = `${goal.domain}_adherence (${keywordOf(goal.title)})`; // one row per goal
      const existing = db.prepare("SELECT id, verdict FROM outcomes WHERE plan_id=? AND metric=?").get(p.id, metric) as { id: string; verdict: string } | undefined;
      if (existing && existing.verdict !== "inconclusive") continue;
      // Baseline from evidence: confirmed completions the week before; unknown history = no baseline.
      const before = countBy(events, goal, addDays(execDate, -7), execDate);
      const baseline = before.scheduled > 0 && before.confirmed + before.missed === 0 ? null : before.confirmed;
      const after = countBy(events, goal, winStart, winEnd);
      const verdict = verdictFor(baseline, after);
      const completeness = after.scheduled ? (after.confirmed + after.missed) / after.scheduled : 0;
      if (existing) update.run(after.confirmed, today, verdict, after.scheduled, after.confirmed, after.missed, after.unknown, completeness, existing.id);
      else upsert.run(newId("out"), p.id, metric, baseline, after.confirmed, today, verdict, after.scheduled, after.confirmed, after.missed, after.unknown, completeness, winStart, winEnd);
      measured.push({ metric, verdict, unknown: after.unknown });
    }
    db.prepare("UPDATE plans SET status='verified' WHERE id=? AND status='executed'").run(p.id);
  }
  return measured;
}

/** Kept for callers that only need the scheduled count (balance widget, goal progress). */
export { goalActual };
