/**
 * "What would help" — one concise, grounded line per weakest life area.
 *
 * Every line is derived from a detected goal deficit (last week's sessions,
 * confirmed vs merely scheduled) plus a FREE SLOT the planner found this week.
 * It states the specific next step and why it addresses the deficit. It never
 * invents causes, missed commitments or expected outcomes; where data is
 * missing it says so. Finance never gets advice — only the user's own numbers,
 * and a request for the missing ones.
 */
import type { DatabaseSync } from "node:sqlite";
import type { EventRow, GoalRow } from "../core/types.js";
import type { DomainScore } from "./balance.js";
import { goalEvents, keywordOf } from "./detectors.js";
import { rankCandidates, timePreferenceFor } from "./solver.js";
import { addDays, weekdayOf } from "./time.js";

export interface HelpLine {
  domain: string;
  line: string;
  /** confirmed = completion evidence; scheduled = calendar only; missing = no data to go on. */
  basis: "confirmed" | "scheduled" | "missing";
  goal_id?: string;
}

const WD = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const when = (iso: string) => `${WD[weekdayOf(iso)]} ${iso.slice(11, 16)}`;
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** Up to `max` lines for the lowest-scoring areas (score < 70), weakest first. */
export function whatWouldHelp(db: DatabaseSync, today: string, balance: DomainScore[], max = 2, personId = "alex"): HelpLine[] {
  const events = db.prepare("SELECT * FROM events WHERE person_id=?").all(personId) as unknown as EventRow[];
  const goals = db.prepare("SELECT * FROM goals WHERE person_id=? AND status='active'").all(personId) as unknown as GoalRow[];
  const memories = db.prepare("SELECT kind, content, status, created_at FROM memory_items WHERE person_id=?").all(personId) as Array<{ kind: string; content: string; status: string; created_at: string }>;
  const weekEnd = addDays(today, 7);
  const weekEvents = events.filter((e) => e.start >= `${today}T00:00:00` && e.start < `${weekEnd}T00:00:00`);
  const out: HelpLine[] = [];

  const weakest = balance.filter((b) => b.score !== null && b.score < 70).sort((a, b) => a.score! - b.score!);
  for (const b of weakest) {
    if (out.length >= max) break;
    if (b.domain === "finance") {
      const line = financeLine(db, today, goals);
      if (line) out.push(line);
      continue;
    }
    if (b.domain === "work") continue; // no goal to restore; the insight + plan handle late evenings
    const domainGoals = goals.filter((g) => g.domain === b.domain);
    if (domainGoals.length === 0) {
      out.push({ domain: b.domain, line: `${cap(b.domain)}: no goal set, so I have nothing to measure here.`, basis: "missing" });
      continue;
    }
    // The goal with the largest deficit last week, judged on evidence.
    let best: { goal: GoalRow; done: number; scheduled: number; unknown: number; deficit: number } | null = null;
    for (const g of domainGoals) {
      const last = goalEvents(events, g, addDays(today, -7), today);
      const done = last.filter((e) => e.completion === "done").length;
      const unknown = last.filter((e) => e.completion === "scheduled" || e.completion === "unknown").length;
      const deficit = g.cadence_per_week - done;
      if (deficit <= 0) continue;
      if (!best || deficit > best.deficit) best = { goal: g, done, scheduled: last.length, unknown, deficit };
    }
    if (!best) continue;
    const g = best.goal;
    const thisWeek = goalEvents(events, g, today, weekEnd).length;
    const candidates = rankCandidates(db, g, timePreferenceFor(g, memories), today, weekEvents, [], 1).filter((c) => !c.suppressed);
    const slot = candidates[0]?.change.start;
    const evidence =
      best.unknown > 0
        ? `${best.done} confirmed of ${g.cadence_per_week} last week (${best.unknown} on the calendar but unconfirmed)`
        : `${best.done} of ${g.cadence_per_week} last week`;
    const step = thisWeek >= g.cadence_per_week ? `${thisWeek} already on this week's calendar — confirming them is what moves the score` : slot ? `a free slot ${when(slot)} this week would restore it` : "no free slot this week without moving something";
    out.push({ domain: b.domain, goal_id: g.id, basis: best.unknown > 0 ? "scheduled" : "confirmed", line: `${cap(b.domain)}: "${keywordOf(g.title)}" is ${evidence} — ${step}.` });
  }
  return out;
}

/** The user's own numbers only. Missing data → ask for it. Never advice. */
function financeLine(db: DatabaseSync, today: string, goals: GoalRow[]): HelpLine | null {
  const fin = goals.filter((g) => g.domain === "finance");
  if (fin.length === 0) return null;
  const month = today.slice(0, 7);
  const day = Number(today.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const parts: string[] = [];
  let basis: HelpLine["basis"] = "confirmed";
  for (const g of fin) {
    const target = Number(g.title.match(/\$(\d+)/)?.[1] ?? 0);
    if (!target) continue;
    const logged = (db.prepare("SELECT COALESCE(SUM(value),0) AS s FROM goal_logs WHERE goal_id=? AND at LIKE ?").get(g.id, `${month}%`) as { s: number }).s;
    const pace = Math.round(target * (day / daysInMonth));
    if (logged === 0) {
      basis = "missing";
      parts.push(`nothing logged yet for "${keywordOf(g.title)}" in ${month} — tell me what went in and I'll check your pace`);
    } else {
      parts.push(`$${logged} of $${target} logged for "${keywordOf(g.title)}"; a steady pace would be at about $${pace} by today`);
    }
  }
  return parts.length ? { domain: "finance", line: `Finance: ${parts.join("; ")}.`, basis } : null;
}

// ---------------------------------------------------------------- once-daily plan offer
/** Durable key/value (survives sessions and restarts; cleared by the demo reset). */
export function kvGet(db: DatabaseSync, key: string): string | null {
  return (db.prepare("SELECT value FROM kv WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null;
}
export function kvSet(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

/**
 * Offer a plan at most once per day, and only when one is actionable: an insight
 * with a goal deficit or a collision in its evidence. Returns the sentence or "".
 * Offering never applies anything — approval still goes through apply_plan.
 */
export function dailyPlanOffer(db: DatabaseSync, today: string): string {
  if (kvGet(db, "plan_offered_on") === today) return "";
  const rows = db.prepare("SELECT evidence FROM insights WHERE status IN ('new','surfaced')").all() as Array<{ evidence: string }>;
  const actionable = rows.some((r) => {
    const e = JSON.parse(r.evidence) as { goals?: unknown[]; collisions?: unknown[]; goalId?: string };
    return (e.goals?.length ?? 0) > 0 || (e.collisions?.length ?? 0) > 0 || typeof e.goalId === "string";
  });
  if (!actionable) return "";
  kvSet(db, "plan_offered_on", today);
  return 'I have a plan ready — say "fix it".';
}
