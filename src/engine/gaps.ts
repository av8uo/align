/**
 * Knowledge-gap discovery and decision-aware inquiry.
 *
 * Gaps are DISCOVERED from rows every engine run — never seeded, never
 * invented. Each gap records what is unknown or contradictory, the evidence
 * ids behind it, its importance (from the user's own value ranking and the
 * severity of what it blocks), and the DECISION the answer would change.
 * The question text is a deterministic template filled only with stated facts.
 */
import type { DatabaseSync } from "node:sqlite";
import type { EventRow, GoalRow, MemoryRow } from "../core/types.js";
import type { Ctx } from "./detectors.js";
import { goalEvents, keywordOf } from "./detectors.js";
import { parseValuesRanking } from "./balance.js";
import { newId } from "../core/ids.js";
import { addDays, dayStart, daysBetween } from "./time.js";

export type GapKind = "unknown" | "contradiction" | "stale";

export interface GapDraft {
  id: string; // deterministic, so re-runs update instead of duplicating
  kind: GapKind;
  topic: string;
  domain: string;
  evidence: Record<string, unknown>;
  /** 0..1 — how much the answer matters, from value ranking + blocked decisions. */
  importance: number;
  /** 0..1 — how little we know (1 = nothing). */
  uncertainty: number;
  /** 0..1 — would the answer change a pending decision right now? */
  leverage: number;
  /** 0..1 — cost to the user (long/awkward questions score higher). */
  burden: number;
  sensitive: boolean;
  decisionRef: string;
  question: string;
  reason: string;
}

const DOMAIN_WEIGHT = (ranking: string[], domain: string): number => {
  const i = ranking.indexOf(domain);
  return i < 0 ? 0.4 : 1 - i * 0.12; // #1 value = 1.0, #6 = 0.4
};

/** A stated fact only: "Married to Sam" → "Sam". Never guessed. */
export function partnerName(memory: MemoryRow[]): string | null {
  for (const m of memory) {
    if (m.kind !== "fact" || m.status !== "active") continue;
    const hit = m.content.match(/\b(?:married to|partner(?: is)?|wife(?: is)?|husband(?: is)?)\s+([A-Z][a-z]+)/i);
    if (hit) return hit[1]!;
  }
  return null;
}

const POSITIVE = /\b(felt great|love|enjoy|like|works well|best|prefer)\b/i;
const NEGATIVE = /\b(hate|dislike|don'?t like|can'?t stand|avoid|not a fan|worst)\b/i;

/** Two active memories about the same goal with opposite polarity = a contradiction worth one question. */
export function findContradictions(memory: MemoryRow[], goals: GoalRow[]): Array<{ goal: GoalRow; positive: MemoryRow; negative: MemoryRow }> {
  const out: Array<{ goal: GoalRow; positive: MemoryRow; negative: MemoryRow }> = [];
  for (const g of goals) {
    const kw = keywordOf(g.title);
    const about = memory.filter((m) => m.status === "active" && ["preference", "experience", "fact"].includes(m.kind) && m.content.toLowerCase().includes(kw));
    const pos = about.filter((m) => POSITIVE.test(m.content) && !NEGATIVE.test(m.content));
    const neg = about.filter((m) => NEGATIVE.test(m.content));
    if (pos.length && neg.length) {
      const newest = (a: MemoryRow, b: MemoryRow) => (a.created_at < b.created_at ? 1 : -1);
      out.push({ goal: g, positive: pos.sort(newest)[0]!, negative: neg.sort(newest)[0]! });
    }
  }
  return out;
}

export function discoverGaps(db: DatabaseSync, ctx: Ctx): GapDraft[] {
  const ranking = parseValuesRanking(ctx);
  const todayIso = dayStart(ctx.today);
  const drafts: GapDraft[] = [];
  const partner = partnerName(ctx.memory);
  const blocked = db
    .prepare("SELECT domains, severity, confidence FROM insights WHERE status IN ('new','surfaced')")
    .all() as Array<{ domains: string; severity: number; confidence: number }>;
  const blockedIn = (domain: string) => blocked.filter((b) => (JSON.parse(b.domains) as string[]).includes(domain));

  // 1) Completion unknown: plan-created events in the past whose outcome nobody confirmed.
  //    The answer decides a plan's verdict and retrains the effectiveness estimate.
  const pendingPlans = db.prepare("SELECT id FROM plans WHERE status IN ('executed','verified')").all() as Array<{ id: string }>;
  if (pendingPlans.length > 0) {
    const byGoal = new Map<string, EventRow[]>();
    for (const e of ctx.events) {
      if (e.source !== "lifeos_plan" || e.start >= todayIso || !["scheduled", "unknown"].includes(e.completion)) continue;
      if (daysBetween(e.start, todayIso) > 21) continue;
      const g = ctx.goals.find((x) => e.title.toLowerCase().includes(keywordOf(x.title)));
      if (!g) continue;
      byGoal.set(g.id, [...(byGoal.get(g.id) ?? []), e]);
    }
    for (const [goalId, evs] of byGoal) {
      const g = ctx.goals.find((x) => x.id === goalId)!;
      const first = evs.sort((a, b) => (a.start < b.start ? -1 : 1))[0]!;
      const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(`${first.start}Z`).getUTCDay()];
      const who = g.domain === "family" && partner && /date/i.test(g.title) ? ` with ${partner}` : "";
      drafts.push({
        id: `gap_completion_${g.id}`,
        kind: "unknown",
        topic: `Whether "${g.title}" happened as planned`,
        domain: g.domain,
        evidence: { eventIds: evs.map((e) => e.id), goalId: g.id, scheduled: evs.length },
        importance: DOMAIN_WEIGHT(ranking, g.domain),
        uncertainty: 1,
        leverage: 1, // decides the outcome verdict + retrains the planner
        burden: 0.1,
        sensitive: false,
        decisionRef: `outcome:${g.id}`,
        question:
          evs.length === 1
            ? `Did ${keywordOf(g.title)}${who} happen on ${day}?`
            : `Last week I scheduled ${keywordOf(g.title)} ${evs.length} times — how many actually happened?`,
        reason: "Without this I can't tell whether last week's plan worked, so I'd be guessing what to propose next.",
      });
    }
  }

  // 2) Progress unknown on a self-reported goal (finance): the pacing arithmetic has no input.
  const month = ctx.today.slice(0, 7);
  const dayOfMonth = Number(ctx.today.slice(8, 10));
  for (const g of ctx.goals) {
    if (g.status !== "active" || g.domain !== "finance") continue;
    const logged = ctx.goalLogs.some((l) => l.goal_id === g.id && l.at.startsWith(month));
    if (logged) continue;
    const target = g.title.match(/\$(\d+)/)?.[1];
    drafts.push({
      id: `gap_progress_${g.id}`,
      kind: "unknown",
      topic: `${month} progress on "${g.title}"`,
      domain: "finance",
      evidence: { goalId: g.id, month, logsThisMonth: 0 },
      importance: DOMAIN_WEIGHT(ranking, "finance"),
      uncertainty: 1,
      // The answer only updates a report (no plan depends on it). Before mid-month
      // it changes little, so leverage is 0 until day 10 and tops out at 0.5 by day 25.
      leverage: 0.5 * Math.max(0, Math.min((dayOfMonth - 10) / 15, 1)),
      burden: 0.15,
      sensitive: false,
      decisionRef: `pacing:${g.id}`,
      question: target ? `You wanted $${target} into the house fund this month — how is it going?` : `How is "${g.title}" going this month?`,
      reason: "The only way to know how you're pacing on a goal you track yourself.",
    });
  }

  // 3) Stale signal in a domain the user ranks highly: no event or memory for ≥21 days.
  //    Leverage is high when an insight in that domain is still hedged (the answer lifts or lowers it).
  for (const domain of ranking.slice(0, 3)) {
    const lastEvent = ctx.events.filter((e) => e.domain === domain && e.start < todayIso && e.completion !== "scheduled").map((e) => e.start).sort().at(-1);
    const lastMemory = ctx.memory.filter((m) => m.status === "active" && m.source === "user_said" && m.created_at >= addDays(ctx.today, -21)).length;
    const days = lastEvent ? daysBetween(lastEvent, todayIso) : 99;
    const insights = blockedIn(domain);
    const hedged = insights.some((i) => i.confidence < 0.75);
    if (days < 21 && lastMemory > 0) continue;
    if (days < 14) continue;
    const who = domain === "family" && partner ? partner : null;
    drafts.push({
      id: `gap_stale_${domain}`,
      kind: "stale",
      topic: `No fresh signal about ${domain} for ${days} days`,
      domain,
      evidence: { lastEventAt: lastEvent ?? null, daysSinceSignal: days, hedgedInsights: insights.filter((i) => i.confidence < 0.75).length },
      importance: DOMAIN_WEIGHT(ranking, domain) * (insights.length ? Math.max(...insights.map((i) => i.severity)) / 3 : 0.5),
      uncertainty: Math.min(days / 28, 1),
      leverage: hedged ? 0.9 : 0.4,
      burden: 0.2,
      sensitive: false,
      decisionRef: hedged ? `insight-confidence:${domain}` : `balance:${domain}`,
      question: who ? `One thing — how are things with ${who} lately?` : domain === "health" ? "How has your energy been lately?" : `How are things going on the ${domain} side lately?`,
      reason: hedged ? "An insight in this area is still a working read; your answer confirms or dissolves it." : "I have no recent signal here, so my picture may be out of date.",
    });
  }

  // 4) Contradictions between what you said at different times — ask, don't guess.
  for (const c of findContradictions(ctx.memory, ctx.goals)) {
    const newerIsNegative = c.negative.created_at > c.positive.created_at;
    drafts.push({
      id: `gap_conflict_${c.goal.id}`,
      kind: "contradiction",
      topic: `Conflicting notes about ${keywordOf(c.goal.title)}`,
      domain: c.goal.domain,
      evidence: { memoryIds: [c.positive.id, c.negative.id], newer: newerIsNegative ? c.negative.id : c.positive.id },
      importance: DOMAIN_WEIGHT(ranking, c.goal.domain) * 0.6,
      uncertainty: 0.6,
      leverage: 0.7, // decides which preference the planner should honor
      burden: 0.2,
      sensitive: false,
      decisionRef: `preference:${c.goal.id}`,
      question: `You once said "${c.positive.content.replace(/[.!]+$/, "")}" and later "${c.negative.content.replace(/[.!]+$/, "")}" — which should I plan around?`,
      reason: "Two of your notes disagree; the planner needs to know which one is current.",
    });
  }

  return drafts;
}

/** Decision-aware expected value of information. Pure, so it is testable on its own. */
export function scoreGap(g: Pick<GapDraft, "importance" | "uncertainty" | "leverage" | "burden" | "sensitive">, declines = 0, daysSinceAsked: number | null = null): number {
  if (g.sensitive) return 0;
  const cooldown = daysSinceAsked === null ? 1 : Math.min(daysSinceAsked / 7, 1);
  return g.importance * g.uncertainty * g.leverage * cooldown - g.burden - 0.3 * declines;
}

/** Below this, asking is not worth the interruption: no question is a valid outcome. */
export const ASK_THRESHOLD = 0.12;

interface StoredGap {
  id: string;
  kind: string;
  topic: string;
  domain: string;
  evidence: string;
  importance: number;
  confidence: number;
  status: string;
  last_asked_at: string | null;
  declines: number;
}

/** Persist discovered gaps (upsert by deterministic id); resolve the ones whose evidence disappeared. */
export function syncGaps(db: DatabaseSync, drafts: GapDraft[], now: string, personId = "alex"): void {
  const existing = db.prepare("SELECT id, status FROM knowledge_gaps WHERE person_id=?").all(personId) as Array<{ id: string; status: string }>;
  const seen = new Set<string>();
  const insert = db.prepare(
    `INSERT INTO knowledge_gaps (id, person_id, topic, domain, blocked_insight_id, confidence, sensitive, last_asked_at, declines, kind, evidence, importance, status, decision_ref, source, created_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, 0, ?, ?, ?, 'open', ?, 'engine', ?)`,
  );
  const update = db.prepare("UPDATE knowledge_gaps SET topic=?, domain=?, confidence=?, kind=?, evidence=?, importance=?, decision_ref=? WHERE id=?");
  for (const d of drafts) {
    seen.add(d.id);
    const row = existing.find((e) => e.id === d.id);
    if (!row) insert.run(d.id, personId, d.topic, d.domain, 1 - d.uncertainty, d.sensitive ? 1 : 0, d.kind, JSON.stringify(d.evidence), d.importance, d.decisionRef, now);
    else if (row.status === "open") update.run(d.topic, d.domain, 1 - d.uncertainty, d.kind, JSON.stringify(d.evidence), d.importance, d.decisionRef, d.id);
  }
  // Engine-discovered gaps whose evidence is gone are resolved (the unknown became known or moot).
  for (const e of existing) {
    if (!seen.has(e.id) && e.status === "open") {
      db.prepare("UPDATE knowledge_gaps SET status='resolved', resolved_at=? WHERE id=? AND source='engine'").run(now, e.id);
    }
  }
}

export interface PickedQuestion {
  id: string;
  gapId: string;
  text: string;
  score: number;
  reason: string;
}

/**
 * Choose at most ONE question: the open gap with the highest decision-aware
 * score above the threshold, respecting cooldowns and declines. Returns null
 * when no answer would materially change what Align does.
 */
export function pickQuestion(db: DatabaseSync, drafts: GapDraft[], today: string, personId = "alex"): PickedQuestion | null {
  const stored = db.prepare("SELECT * FROM knowledge_gaps WHERE person_id=? AND status='open'").all(personId) as unknown as StoredGap[];
  const todayIso = dayStart(today);
  const scored = drafts
    .map((d) => {
      const row = stored.find((s) => s.id === d.id);
      if (!row) return null;
      const since = row.last_asked_at ? daysBetween(row.last_asked_at, todayIso) : null;
      if (since !== null && since < 7) return null; // asked within the week
      if (row.declines >= 2) return null;
      return { d, score: scoreGap(d, row.declines, since) };
    })
    .filter((x): x is { d: GapDraft; score: number } => x !== null)
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top || top.score < ASK_THRESHOLD) return null;

  const pending = db
    .prepare("SELECT id, text FROM questions WHERE gap_id=? AND status='pending'")
    .get(top.d.id) as { id: string; text: string } | undefined;
  if (pending) return { id: pending.id, gapId: top.d.id, text: pending.text, score: top.score, reason: top.d.reason };
  const id = newId("q");
  db.prepare("INSERT INTO questions (id, gap_id, text, evi_score, status, reason) VALUES (?, ?, ?, ?, 'pending', ?)").run(id, top.d.id, top.d.question, top.score, top.d.reason);
  return { id, gapId: top.d.id, text: top.d.question, score: top.score, reason: top.d.reason };
}

/** Helper for tools: the events a goal's completion question refers to. */
export const completionEventsFor = (events: EventRow[], g: GoalRow, from: string, to: string) => goalEvents(events, g, from, to);
