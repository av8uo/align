/**
 * Life Balance scoring (feeds the flagship widget) + G3 attention-drift detection.
 * All arithmetic — the user's own stated value ranking is the yardstick.
 */
import type { Ctx, Finding } from "./detectors.js";
import { currencyOf, goalActual, goalEvents, moneyTarget } from "./detectors.js";
import { addDays, dayStart, hoursBetween, minutesOf } from "./time.js";

export interface DomainScore {
  domain: string;
  score: number | null; // null = not enough data ("unknown" on the widget)
  trend: "up" | "down" | "flat";
  freshnessDays: number; // days since any signal in this domain
  note: string;
  planned?: number | null; // score if next week's scheduled sessions happen (the widget's faint bar)
}

const LIFE_DOMAINS = ["family", "health", "personal", "work", "household", "finance"] as const;

/** Parse "Values ranking: 1) marriage & family 2) health ..." from a preference memory. */
export function parseValuesRanking(ctx: Ctx): string[] {
  const pref = ctx.memory.find((m) => m.kind === "preference" && /values ranking/i.test(m.content));
  if (!pref) return [];
  const names = [...pref.content.matchAll(/\d\)\s*([a-z&' ]+)/gi)].map((m) => m[1]!.trim().toLowerCase());
  const map: Record<string, string> = {
    "marriage & family": "family",
    family: "family",
    health: "health",
    "personal growth": "personal",
    career: "work",
    finances: "finance",
    household: "household",
  };
  return names.map((n) => map[n] ?? n).filter((d) => (LIFE_DOMAINS as readonly string[]).includes(d));
}

/**
 * Evidence-weighted sessions: done counts 1, missed 0, and a past session
 * nobody has confirmed counts half — scheduled is not done, but not failed either.
 * So the widget moves when the user confirms ("Yes, we did!"), not when time passes.
 */
function evidencedActual(ctx: Ctx, g: Ctx["goals"][number], from: string, to: string): number {
  return goalEvents(ctx.events, g, from, to).reduce((a, e) => a + (e.completion === "done" ? 1 : e.completion === "missed" ? 0 : 0.5), 0);
}

function goalAdherence(ctx: Ctx, domain: string, from: string, to: string, count = evidencedActual): number | null {
  const goals = ctx.goals.filter((g) => g.domain === domain && g.status === "active" && g.domain !== "finance");
  if (goals.length === 0) return null;
  const ratios = goals.map((g) => Math.min(count(ctx, g, from, to) / g.cadence_per_week, 1));
  return ratios.reduce((a, b) => a + b, 0) / ratios.length;
}

/** The coming week as scheduled — what the score becomes if the plan happens. */
const scheduledAhead = (ctx: Ctx, g: Ctx["goals"][number], from: string, to: string) => goalActual(ctx.events, g, from, to);

function freshnessDays(ctx: Ctx, domain: string): number {
  const todayIso = dayStart(ctx.today);
  const eventTimes = ctx.events.filter((e) => e.domain === domain && e.start < todayIso).map((e) => e.start);
  const last = eventTimes.sort().at(-1);
  if (!last) return 99;
  const ms = Date.parse(`${todayIso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${last.slice(0, 10)}T00:00:00Z`);
  return Math.floor(ms / 86_400_000);
}

function workScore(ctx: Ctx, from: string, to: string): { score: number; note: string } {
  const work = ctx.events.filter((e) => e.domain === "work" && e.start >= dayStart(from) && e.start < dayStart(to));
  const hours = work.reduce((a, e) => a + hoursBetween(e.start, e.end), 0);
  const late = work.filter((e) => minutesOf(e.end) > 18 * 60 + 30).length;
  const overHours = Math.max(hours - 40, 0);
  const score = Math.max(0, Math.min(100, Math.round(100 - overHours * 5 - late * 8)));
  return { score, note: late > 0 ? `${late} late evenings, ~${Math.round(overHours)}h over plan` : "on plan" };
}

export function lifeBalance(ctx: Ctx): DomainScore[] {
  const weekFrom = addDays(ctx.today, -7);
  const prevFrom = addDays(ctx.today, -14);
  const out: DomainScore[] = [];

  for (const domain of LIFE_DOMAINS) {
    const fresh = freshnessDays(ctx, domain);
    if (domain === "work") {
      const { score, note } = workScore(ctx, weekFrom, ctx.today);
      const prev = workScore(ctx, prevFrom, weekFrom).score;
      out.push({ domain, score, trend: score > prev ? "up" : score < prev ? "down" : "flat", freshnessDays: fresh, note });
      continue;
    }
    if (domain === "finance") {
      // Pacing on the user's own stated targets: logged this month vs what a steady
      // pace would have reached by today. No finance goal → unknown; nothing logged → 0.
      const goals = ctx.goals.filter((g) => g.domain === "finance" && g.status === "active");
      const month = ctx.today.slice(0, 7);
      const day = Number(ctx.today.slice(8, 10));
      const daysInMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
      let target = 0;
      let logged = 0;
      for (const g of goals) {
        target += moneyTarget(g.title);
        logged += ctx.goalLogs.filter((l) => l.goal_id === g.id && l.at.startsWith(month)).reduce((a, l) => a + (l.value ?? 0), 0);
      }
      if (target === 0) {
        out.push({ domain, score: null, trend: "flat", freshnessDays: fresh, note: "no finance goal set" });
        continue;
      }
      const expected = target * (day / daysInMonth);
      const score = Math.round(Math.max(0, Math.min(100, (logged / expected) * 100)));
      out.push({ domain, score, trend: "flat", freshnessDays: fresh, note: logged === 0 ? `nothing logged yet in ${month}` : `${currencyOf(goals[0]!.title)}${logged} of ${currencyOf(goals[0]!.title)}${target} this month` });
      continue;
    }
    const adh = goalAdherence(ctx, domain, weekFrom, ctx.today);
    if (adh === null) {
      out.push({ domain, score: null, trend: "flat", freshnessDays: fresh, note: "no goals set" });
      continue;
    }
    const prevAdh = goalAdherence(ctx, domain, prevFrom, weekFrom) ?? adh;
    const freshFactor = Math.max(0, 1 - fresh / 21);
    const score = Math.round(100 * (0.7 * adh + 0.3 * freshFactor));
    const ahead = goalAdherence(ctx, domain, ctx.today, addDays(ctx.today, 7), scheduledAhead) ?? 0;
    out.push({
      domain,
      score,
      trend: adh > prevAdh ? "up" : adh < prevAdh ? "down" : "flat",
      freshnessDays: fresh,
      note: `goal adherence ${Math.round(adh * 100)}%`,
      planned: ahead > 0 ? Math.round(100 * (0.7 * ahead + 0.3)) : null,
    });
  }
  return out;
}

/** G3 — attention drift: the user's #1 value is starving while work balloons. */
export function g3AttentionDrift(ctx: Ctx, balance: DomainScore[]): Finding[] {
  const ranking = parseValuesRanking(ctx);
  const top = ranking[0];
  if (!top) return [];
  const topScore = balance.find((b) => b.domain === top);
  const work = balance.find((b) => b.domain === "work");
  if (topScore?.score != null && topScore.score < 50 && work?.score != null && work.score < 70) {
    return [
      {
        detector: "G3",
        domains: [top, "work"],
        severity: 3,
        title: `Attention drift: time is flowing to work while ${top} — your #1 value — is starving`,
        evidence: { topValue: top, topScore: topScore.score, workScore: work.score, ranking },
        confidence: 0.85,
      },
    ];
  }
  return [];
}
