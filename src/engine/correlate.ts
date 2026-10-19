/**
 * Cross-domain correlator: merges related findings into composite insights.
 * This is the "more than a calendar chatbot" proof — work overload + family
 * neglect + personal-goal stalls become ONE explainable insight.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Finding } from "./detectors.js";
import type { Ctx } from "./detectors.js";
import { newId } from "../core/ids.js";
import { dayStart, daysBetween } from "./time.js";

export interface InsightDraft {
  detectors: string[];
  domains: string[];
  severity: number;
  title: string;
  evidence: Record<string, unknown>;
  reasoning: string;
  confidence: number;
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

/** Supporting memory (e.g. "work is eating everything") raises composite confidence. */
function memorySupport(ctx: Ctx): { boost: number; memoryIds: string[] } {
  const todayIso = dayStart(ctx.today);
  const recent = ctx.memory.filter(
    (m) =>
      m.kind === "experience" &&
      m.status === "active" &&
      /work|busy/i.test(m.content) &&
      daysBetween(m.created_at, todayIso) <= 14,
  );
  return { boost: Math.min(recent.length * 0.1, 0.3), memoryIds: recent.map((m) => m.id) };
}

export function correlate(ctx: Ctx, findings: Finding[]): InsightDraft[] {
  const drafts: InsightDraft[] = [];
  const overload = findings.filter((f) => f.detector === "G4" || (f.detector === "G3" && f.domains.includes("work")));
  const starved = findings.filter(
    (f) => ["G1", "G2", "G8"].includes(f.detector) && f.domains.some((d) => d !== "work"),
  );

  const consumed = new Set<Finding>();
  if (overload.length > 0 && starved.some((f) => f.domains.includes("family"))) {
    const members = [...overload, ...starved];
    members.forEach((f) => consumed.add(f));
    const support = memorySupport(ctx);
    const starvedNames = [
      ...new Set(
        starved
          .map((f) => (f.evidence.goalId as string | undefined) ? f.title : null)
          .filter((t): t is string => t !== null),
      ),
    ];
    const merged = mergeEvidence(members);
    const evidence = { ...merged, supportingMemoryIds: support.memoryIds };
    drafts.push({
      detectors: [...new Set(members.map((m) => m.detector))].sort(),
      domains: [...new Set(members.flatMap((m) => m.domains))].sort(),
      severity: 3,
      title: "Work is crowding out your family time and personal goals",
      evidence,
      reasoning:
        `Last week work ran late ${merged.lateEvenings} evenings. Meanwhile: ${starvedNames.join("; ")}. ` +
        `Looking ahead, this week repeats the pattern unless something changes.`,
      confidence: Math.min(0.6 + support.boost + (starved.length >= 3 ? 0.1 : 0), 0.95),
    });
  }

  for (const f of findings) {
    if (consumed.has(f)) continue;
    drafts.push({
      detectors: [f.detector],
      domains: f.domains,
      severity: f.severity,
      title: f.title,
      evidence: f.evidence,
      reasoning: f.title,
      confidence: f.confidence,
    });
  }
  return drafts;
}

/** Upsert by title: re-running the engine updates evidence instead of duplicating. */
export function upsertInsights(db: DatabaseSync, drafts: InsightDraft[], now: string): string[] {
  const ids: string[] = [];
  const find = db.prepare("SELECT id FROM insights WHERE title = ?");
  const update = db.prepare(
    "UPDATE insights SET detectors=?, domains=?, severity=?, evidence=?, reasoning=?, confidence=? WHERE id=?",
  );
  const insert = db.prepare(
    `INSERT INTO insights (id, detectors, domains, severity, title, evidence, reasoning, confidence, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
  );
  for (const d of drafts) {
    const existing = find.get(d.title) as { id: string } | undefined;
    const id = existing?.id ?? newId("ins");
    if (existing) {
      update.run(JSON.stringify(d.detectors), JSON.stringify(d.domains), d.severity, JSON.stringify(d.evidence), d.reasoning, d.confidence, id);
    } else {
      insert.run(id, JSON.stringify(d.detectors), JSON.stringify(d.domains), d.severity, d.title, JSON.stringify(d.evidence), d.reasoning, d.confidence, now);
    }
    ids.push(id);
  }
  // Insights that no longer reproduce are dismissed, not left to go stale.
  const titles = drafts.map((d) => d.title);
  if (titles.length > 0) {
    db.prepare(
      `UPDATE insights SET status='dismissed' WHERE status='new' AND title NOT IN (${titles.map(() => "?").join(",")})`,
    ).run(...titles);
  }
  return ids;
}
