/**
 * Deterministic detectors G1–G8 (G3 lives in balance.ts). Pure functions over
 * loaded rows — no LLM involved. Each returns Findings with explicit evidence so
 * every insight is explainable. Minimum-evidence rules: a single observation
 * never becomes a pattern; findings without history carry low confidence and
 * are suppressed from speech by the correlator.
 */
import type { EventRow, GoalRow, MemoryRow } from "../core/types.js";
import { addDays, dayStart, minutesOf, overlaps, daysBetween } from "./time.js";

export interface Finding {
  detector: "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7" | "G8";
  domains: string[];
  severity: 1 | 2 | 3;
  title: string;
  evidence: Record<string, unknown>;
  confidence: number;
}

export interface Ctx {
  today: string; // YYYY-MM-DD (start of the current week in the demo)
  events: EventRow[];
  goals: GoalRow[];
  memory: MemoryRow[];
  goalLogs: Array<{ goal_id: string; at: string; value: number | null }>;
}

/** Keyword used to match events to a goal ("Date night with Sam" -> "date night"). */
export function keywordOf(goalTitle: string): string {
  return goalTitle.toLowerCase().split(" ").slice(0, 2).join(" ");
}

const matches = (e: EventRow, g: GoalRow): boolean =>
  e.title.toLowerCase().includes(keywordOf(g.title));

const inWindow = (e: EventRow, from: string, to: string): boolean =>
  e.start >= dayStart(from) && e.start < dayStart(to);

/** Events matching a goal in a window — scheduled, done, missed or unknown alike. */
export function goalEvents(events: EventRow[], g: GoalRow, from: string, to: string): EventRow[] {
  return events.filter((e) => matches(e, g) && inWindow(e, from, to));
}

/**
 * How many of a goal's sessions were on the calendar in a window. This is
 * SCHEDULED adherence — planning signal, not proof anything happened. Outcome
 * measurement uses completion evidence instead (see learn.ts).
 */
export function goalActual(events: EventRow[], g: GoalRow, from: string, to: string): number {
  return goalEvents(events, g, from, to).filter((e) => e.completion !== "missed").length;
}

/**
 * G6 — trend: weekly scheduled adherence over the last 4 full weeks. Declared
 * only with ≥3 weeks of data and a monotone direction — one bad week is not a
 * pattern. Limitation: measures what was on the calendar, not completion.
 */
export function g6Trend(ctx: Ctx): Finding[] {
  const out: Finding[] = [];
  for (const g of ctx.goals) {
    if (g.status !== "active" || g.domain === "finance" || g.cadence_per_week === 0) continue;
    const weeks: number[] = [];
    for (let k = 4; k >= 1; k--) {
      const from = addDays(ctx.today, -7 * k);
      const to = addDays(ctx.today, -7 * (k - 1));
      const any = ctx.events.some((e) => inWindow(e, from, to)); // the calendar covers this week at all
      if (!any) continue;
      weeks.push(Math.min(goalActual(ctx.events, g, from, to) / g.cadence_per_week, 1));
    }
    if (weeks.length < 3) continue;
    const last3 = weeks.slice(-3);
    const falling = last3[0]! > last3[1]! && last3[1]! >= last3[2]! && last3[0]! - last3[2]! >= 0.5;
    const rising = last3[0]! < last3[1]! && last3[1]! <= last3[2]! && last3[2]! - last3[0]! >= 0.5;
    if (!falling && !rising) continue;
    out.push({
      detector: "G6",
      domains: [g.domain],
      severity: falling ? 2 : 1,
      title: falling ? `${g.title} has fallen off over three weeks` : `${g.title} is trending up over three weeks`,
      evidence: { goalId: g.id, weeklyAdherence: last3.map((w) => Math.round(w * 100) / 100), weeks: 3, direction: falling ? "down" : "up" },
      confidence: 0.8,
    });
  }
  return out;
}

/** G1 — goal deficit over the last full week. */
export function g1GoalDeficit(ctx: Ctx): Finding[] {
  const from = addDays(ctx.today, -7);
  const out: Finding[] = [];
  for (const g of ctx.goals) {
    if (g.status !== "active" || g.domain === "finance") continue;
    const actual = goalActual(ctx.events, g, from, ctx.today);
    if (actual < g.cadence_per_week) {
      out.push({
        detector: "G1",
        domains: [g.domain],
        severity: actual === 0 ? 2 : 1,
        title: `${g.title}: ${actual} of ${g.cadence_per_week} last week`,
        evidence: { goalId: g.id, actual, target: g.cadence_per_week, window: [from, ctx.today] },
        confidence: 0.95,
      });
    }
  }
  return out;
}

/** G2 — neglect: a recurring commitment with no matching event for >14 days. */
export function g2Neglect(ctx: Ctx): Finding[] {
  const out: Finding[] = [];
  const todayIso = dayStart(ctx.today);
  for (const g of ctx.goals) {
    if (g.status !== "active" || g.domain === "finance") continue;
    const past = ctx.events.filter((e) => matches(e, g) && e.start < todayIso);
    const last = past.sort((a, b) => (a.start < b.start ? 1 : -1))[0];
    const daysSince = last ? daysBetween(last.start, todayIso) : 999;
    if (daysSince > 14) {
      out.push({
        detector: "G2",
        domains: [g.domain],
        severity: g.domain === "family" ? 3 : 2,
        title: `No "${g.title}" in ${daysSince === 999 ? "recorded history" : `${daysSince} days`}`,
        evidence: { goalId: g.id, daysSince, lastEventId: last?.id ?? null, window: [last?.start ?? null, todayIso] },
        // No recorded history at all is weak evidence: the calendar may simply not cover it.
        confidence: last ? 0.95 : 0.5,
      });
    }
  }
  return out;
}

/** G4 — career overload / evening creep over the last week. */
export function g4EveningCreep(ctx: Ctx): Finding[] {
  const from = addDays(ctx.today, -7);
  const late = ctx.events.filter(
    (e) => e.domain === "work" && inWindow(e, from, ctx.today) && minutesOf(e.end) > 18 * 60 + 30,
  );
  if (late.length < 3) return [];
  return [
    {
      detector: "G4",
      domains: ["work"],
      severity: 3,
      title: `Work ran past 18:30 on ${late.length} evenings last week`,
      evidence: { eventIds: late.map((e) => e.id), lateEvenings: late.length, window: [from, ctx.today] },
      confidence: 0.95,
    },
  ];
}

/** G5 — postponement chains. */
export function g5Postponement(ctx: Ctx): Finding[] {
  return ctx.events
    .filter((e) => e.reschedule_count >= 3)
    .map((e) => ({
      detector: "G5" as const,
      domains: [e.domain],
      severity: 2 as const,
      title: `"${e.title}" has been rescheduled ${e.reschedule_count} times`,
      evidence: { eventIds: [e.id], rescheduleCount: e.reschedule_count },
      confidence: 0.95,
    }));
}

/** G7 — financial-goal pacing: the user's own numbers only, never advice (policy C4). */
export function g7FinancePacing(ctx: Ctx): Finding[] {
  const month = ctx.today.slice(0, 7);
  const out: Finding[] = [];
  for (const g of ctx.goals) {
    if (g.status !== "active" || g.domain !== "finance") continue;
    const target = Number(g.title.match(/\$(\d+)/)?.[1] ?? 0);
    if (!target) continue;
    const logs = ctx.goalLogs.filter((l) => l.goal_id === g.id && l.at.startsWith(month));
    const sum = logs.reduce((a, l) => a + (l.value ?? 0), 0);
    if (logs.length === 0) {
      out.push({
        detector: "G7",
        domains: ["finance"],
        severity: 2,
        title: `No progress logged in ${month} on "${g.title}"`,
        evidence: { goalId: g.id, month, target, logged: 0 },
        confidence: 0.7,
      });
    } else if (sum < target) {
      out.push({
        detector: "G7",
        domains: ["finance"],
        severity: 1,
        title: `House fund: $${sum} of $${target} logged so far in ${month}`,
        evidence: { goalId: g.id, month, target, logged: sum },
        confidence: 0.9,
      });
    }
  }
  return out;
}

/** G8 — forward scan: next week's deficits and work×family collisions, before they happen. */
export function g8ForwardScan(ctx: Ctx): Finding[] {
  const to = addDays(ctx.today, 7);
  const out: Finding[] = [];

  for (const g of ctx.goals) {
    if (g.status !== "active" || g.domain === "finance") continue;
    const scheduled = goalActual(ctx.events, g, ctx.today, to);
    if (scheduled === 0 && g.cadence_per_week > 0) {
      out.push({
        detector: "G8",
        domains: [g.domain],
        severity: 2,
        title: `Upcoming: zero "${g.title}" scheduled this week`,
        evidence: { goalId: g.id, scheduled, target: g.cadence_per_week, window: [ctx.today, to] },
        confidence: 0.9,
      });
    }
  }

  const week = ctx.events.filter((e) => inWindow(e, ctx.today, to));
  const collisions: Array<[string, string]> = [];
  for (const w of week.filter((e) => e.domain === "work")) {
    for (const f of week.filter((e) => e.domain === "family")) {
      if (overlaps(w.start, w.end, f.start, f.end)) collisions.push([w.id, f.id]);
    }
  }
  if (collisions.length > 0) {
    out.push({
      detector: "G8",
      domains: ["work", "family"],
      severity: 3,
      title: `Upcoming: ${collisions.length} work–family collision(s) this week`,
      evidence: { collisions },
      confidence: 0.95,
    });
  }
  return out;
}

export function runDetectors(ctx: Ctx): Finding[] {
  return [
    ...g1GoalDeficit(ctx),
    ...g2Neglect(ctx),
    ...g4EveningCreep(ctx),
    ...g5Postponement(ctx),
    ...g6Trend(ctx),
    ...g7FinancePacing(ctx),
    ...g8ForwardScan(ctx),
  ];
}
