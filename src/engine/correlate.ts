/**
 * Cross-domain correlator: merges related findings into composite insights.
 *
 * Every insight it emits is evidence-grounded:
 *  - records: the exact event / goal / memory ids and the time window
 *  - stated vs inferred: which memories the user said vs what the engine derived
 *  - alternatives: competing explanations the evidence cannot exclude
 *  - missing: what would raise confidence; would_change: what would dissolve it
 * Correlation is reported as co-occurrence, never as proven cause. Weak
 * findings (no history, single observation) are suppressed, not spoken.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Finding } from "./detectors.js";
import type { Ctx } from "./detectors.js";
import { newId } from "../core/ids.js";
import { dayStart, daysBetween } from "./time.js";

export interface EvidenceRecord {
  type: "event" | "goal" | "memory";
  id: string;
  role: string;
}

export interface InsightEvidence {
  records: EvidenceRecord[];
  window: [string, string] | null;
  stated: string[]; // memory ids with source user_said / seed (the user told us)
  inferred: string[]; // memory ids the engine produced
  alternatives: string[];
  missing: string[];
  would_change: string;
  /** Raw detector evidence kept for the planner and tests. */
  [k: string]: unknown;
}

export interface InsightDraft {
  detectors: string[];
  domains: string[];
  severity: number;
  title: string;
  evidence: InsightEvidence;
  reasoning: string;
  confidence: number;
  /** Below this the insight is stored but not surfaced in a briefing. */
  weak: boolean;
}

export const SPEAK_THRESHOLD = 0.6;

function recordsOf(f: Finding): EvidenceRecord[] {
  const out: EvidenceRecord[] = [];
  for (const id of (f.evidence.eventIds as string[] | undefined) ?? []) out.push({ type: "event", id, role: f.detector });
  if (typeof f.evidence.goalId === "string") out.push({ type: "goal", id: f.evidence.goalId, role: f.detector });
  if (typeof f.evidence.lastEventId === "string") out.push({ type: "event", id: f.evidence.lastEventId, role: "last occurrence" });
  for (const [w, fam] of (f.evidence.collisions as Array<[string, string]> | undefined) ?? []) {
    out.push({ type: "event", id: w, role: "collision:work" }, { type: "event", id: fam, role: "collision:family" });
  }
  return out;
}

function windowOf(findings: Finding[]): [string, string] | null {
  const ws = findings.map((f) => f.evidence.window as [string | null, string] | undefined).filter((w): w is [string, string] => !!w && !!w[0]);
  if (ws.length === 0) return null;
  return [ws.map((w) => w[0]).sort()[0]!, ws.map((w) => w[1]).sort().at(-1)!];
}

function mergeEvidence(findings: Finding[]): Record<string, unknown> {
  const eventIds = new Set<string>();
  const goals: unknown[] = [];
  const collisions: unknown[] = [];
  let lateEvenings = 0;
  for (const f of findings) {
    for (const id of (f.evidence.eventIds as string[] | undefined) ?? []) eventIds.add(id);
    if (f.evidence.goalId) goals.push(f.evidence);
    for (const c of (f.evidence.collisions as unknown[] | undefined) ?? []) collisions.push(c);
    if (typeof f.evidence.lateEvenings === "number") lateEvenings = f.evidence.lateEvenings;
  }
  return { eventIds: [...eventIds], goals, collisions, lateEvenings, findings: findings.map((f) => f.title) };
}

/**
 * Supporting memory raises composite confidence — with freshness decay: a
 * remark from this week counts fully, one from two weeks ago half as much.
 */
function memorySupport(ctx: Ctx): { boost: number; memoryIds: string[] } {
  const todayIso = dayStart(ctx.today);
  let boost = 0;
  const ids: string[] = [];
  for (const m of ctx.memory) {
    if (m.kind !== "experience" || m.status !== "active" || !/work|busy/i.test(m.content)) continue;
    const age = daysBetween(m.created_at, todayIso);
    if (age > 14) continue;
    boost += 0.1 * (age <= 7 ? 1 : 0.5);
    ids.push(m.id);
  }
  return { boost: Math.min(boost, 0.3), memoryIds: ids };
}

/** How many of the last 3 weeks had ≥3 late work evenings — one week is a bad week, not a pattern. */
function overloadWeeks(ctx: Ctx): number {
  const todayIso = dayStart(ctx.today);
  let weeks = 0;
  for (let k = 1; k <= 3; k++) {
    const from = daysBetween("1970-01-01T00:00:00", todayIso) - 7 * k;
    const late = ctx.events.filter((e) => {
      const d = daysBetween("1970-01-01T00:00:00", dayStart(e.start.slice(0, 10)));
      return e.domain === "work" && d >= from && d < from + 7 && Number(e.end.slice(11, 13)) * 60 + Number(e.end.slice(14, 16)) > 18 * 60 + 30;
    }).length;
    if (late >= 3) weeks++;
  }
  return weeks;
}

export function correlate(ctx: Ctx, findings: Finding[]): InsightDraft[] {
  const drafts: InsightDraft[] = [];
  // Weak findings (below the speak threshold) never join a composite: they are
  // stored as weak on their own, so a guess can't borrow a strong insight's confidence.
  const strong = findings.filter((f) => f.confidence >= SPEAK_THRESHOLD);
  const overload = strong.filter((f) => f.detector === "G4" || (f.detector === "G3" && f.domains.includes("work")));
  const starved = strong.filter((f) => ["G1", "G2", "G8"].includes(f.detector) && f.domains.some((d) => d !== "work"));
  const statedIds = (ids: string[]) => ids.filter((id) => ctx.memory.find((m) => m.id === id)?.source !== "engine_inferred");
  const inferredIds = (ids: string[]) => ids.filter((id) => ctx.memory.find((m) => m.id === id)?.source === "engine_inferred");

  const consumed = new Set<Finding>();
  if (overload.length > 0 && starved.some((f) => f.domains.includes("family"))) {
    const members = [...overload, ...starved];
    members.forEach((f) => consumed.add(f));
    const support = memorySupport(ctx);
    const starvedNames = [...new Set(starved.map((f) => ((f.evidence.goalId as string | undefined) ? f.title : null)).filter((t): t is string => t !== null))];
    const merged = mergeEvidence(members);
    const weeks = overloadWeeks(ctx);
    const alternatives = [
      weeks < 2 ? "This may be one unusually heavy work week rather than a pattern (only one week of overload in the record)." : "Work has run late in several recent weeks, so a one-off week is unlikely.",
      "The family and personal gaps could have their own causes (travel, illness, a choice) that the calendar does not show.",
    ];
    const missing = [
      ...(support.memoryIds.length === 0 ? ["Your own account of why the evenings ran long."] : []),
      "Whether the missed sessions were skipped or simply never scheduled.",
    ];
    const confidence = Math.min(0.5 + support.boost + (starved.length >= 3 ? 0.1 : 0) + (weeks >= 2 ? 0.1 : 0), 0.95);
    drafts.push({
      detectors: [...new Set(members.map((m) => m.detector))].sort(),
      domains: [...new Set(members.flatMap((m) => m.domains))].sort(),
      severity: 3,
      title: "Work is crowding out your family time and personal goals",
      evidence: {
        ...merged,
        records: [...new Map(members.flatMap(recordsOf).map((r) => [`${r.type}:${r.id}:${r.role}`, r])).values()],
        window: windowOf(members),
        stated: statedIds(support.memoryIds),
        inferred: inferredIds(support.memoryIds),
        supportingMemoryIds: support.memoryIds,
        alternatives,
        missing,
        would_change: "A week with evenings free of work while the family and personal sessions still slip — then work isn't the displacing force.",
        overloadWeeks: weeks,
      },
      reasoning:
        `Last week work ran past 18:30 on ${merged.lateEvenings} evenings. In the same period: ${starvedNames.join("; ")}. ` +
        `These coincide; I can't prove one causes the other, but this week repeats the pattern unless something changes.`,
      confidence,
      weak: confidence < SPEAK_THRESHOLD,
    });
  }

  for (const f of findings) {
    if (consumed.has(f)) continue;
    const weak = f.confidence < SPEAK_THRESHOLD;
    drafts.push({
      detectors: [f.detector],
      domains: f.domains,
      severity: f.severity,
      title: f.title,
      evidence: {
        ...f.evidence,
        records: recordsOf(f),
        window: (f.evidence.window as [string, string] | undefined) ?? null,
        stated: [],
        inferred: [],
        alternatives: weak ? ["The calendar may simply not record this activity."] : [],
        missing: weak ? ["Any past occurrence on record, or your confirmation that it happened."] : [],
        would_change: "A matching event or your correction.",
      },
      reasoning: f.title,
      confidence: f.confidence,
      weak,
    });
  }
  return drafts;
}

/** Upsert by title: re-running the engine updates evidence instead of duplicating. Weak insights are stored as 'weak', never surfaced. */
export function upsertInsights(db: DatabaseSync, drafts: InsightDraft[], now: string): string[] {
  const ids: string[] = [];
  const find = db.prepare("SELECT id, status FROM insights WHERE title = ?");
  const update = db.prepare("UPDATE insights SET detectors=?, domains=?, severity=?, evidence=?, reasoning=?, confidence=?, status=? WHERE id=?");
  const insert = db.prepare(
    `INSERT INTO insights (id, detectors, domains, severity, title, evidence, reasoning, confidence, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const d of drafts) {
    const existing = find.get(d.title) as { id: string; status: string } | undefined;
    const id = existing?.id ?? newId("ins");
    // A weak insight stays weak; a strong one keeps its lifecycle status (new → surfaced), or revives from weak.
    const status = d.weak ? "weak" : existing && existing.status !== "weak" && existing.status !== "dismissed" ? existing.status : "new";
    if (existing) update.run(JSON.stringify(d.detectors), JSON.stringify(d.domains), d.severity, JSON.stringify(d.evidence), d.reasoning, d.confidence, status, id);
    else insert.run(id, JSON.stringify(d.detectors), JSON.stringify(d.domains), d.severity, d.title, JSON.stringify(d.evidence), d.reasoning, d.confidence, status, now);
    ids.push(id);
  }
  // Insights that no longer reproduce are dismissed, not left to go stale.
  const titles = drafts.map((d) => d.title);
  if (titles.length > 0) {
    db.prepare(`UPDATE insights SET status='dismissed' WHERE status IN ('new','surfaced','weak') AND title NOT IN (${titles.map(() => "?").join(",")})`).run(...titles);
  } else {
    db.prepare("UPDATE insights SET status='dismissed' WHERE status IN ('new','surfaced','weak')").run();
  }
  return ids;
}
