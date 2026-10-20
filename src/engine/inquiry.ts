/**
 * Proactive inquiry: pick the ONE question whose answer would most improve
 * Align's understanding (expected value of information). Deterministic scoring;
 * an LLM may rephrase the text later, never choose the question.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Ctx } from "./detectors.js";
import { newId } from "../core/ids.js";
import { addDays, dayStart, daysBetween } from "./time.js";

interface GapRow {
  id: string;
  person_id: string;
  topic: string;
  domain: string;
  confidence: number;
  sensitive: number;
  last_asked_at: string | null;
  declines: number;
}

const TEMPLATES: Record<string, string> = {
  gap_marriage: "One thing — how are things with Sam lately?",
  gap_finance_oct: "You wanted $500 into the house fund this month — how did October go?",
  gap_friends: "Have you managed to see friends lately?",
};

function maxSeverityByDomain(db: DatabaseSync): Map<string, number> {
  const rows = db
    .prepare("SELECT domains, severity FROM insights WHERE status IN ('new','surfaced')")
    .all() as Array<{ domains: string; severity: number }>;
  const map = new Map<string, number>();
  for (const r of rows) {
    for (const d of JSON.parse(r.domains) as string[]) {
      map.set(d, Math.max(map.get(d) ?? 0, r.severity));
    }
  }
  return map;
}

export function scoreGap(gap: GapRow, blockedSeverity: number, today: string): number {
  const staleness =
    gap.last_asked_at === null ? 1 : Math.min(daysBetween(gap.last_asked_at, dayStart(today)) / 21, 1);
  return 0.5 * (blockedSeverity / 3) + 0.4 * (1 - gap.confidence) + 0.1 * staleness - 0.3 * gap.declines;
}

/** Choose the top eligible gap and ensure a pending question exists for it. */
export function pickQuestion(
  db: DatabaseSync,
  ctx: Ctx,
  personId = "alex",
): { id: string; gapId: string; text: string; score: number } | null {
  const gaps = db.prepare("SELECT * FROM knowledge_gaps WHERE person_id = ?").all(personId) as unknown as GapRow[];
  const sevByDomain = maxSeverityByDomain(db);
  const cutoff = addDays(ctx.today, -7);

  const scored = gaps
    .filter(
      (g) =>
        g.sensitive === 0 &&
        g.declines < 2 &&
        (g.last_asked_at === null || g.last_asked_at.slice(0, 10) <= cutoff),
    )
    .map((g) => ({ gap: g, score: scoreGap(g, sevByDomain.get(g.domain) ?? 0, ctx.today) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score <= 0) return null;

  const pending = db
    .prepare("SELECT id, gap_id, text, evi_score FROM questions WHERE gap_id = ? AND status = 'pending'")
    .get(top.gap.id) as { id: string; gap_id: string; text: string; evi_score: number } | undefined;
  if (pending) return { id: pending.id, gapId: pending.gap_id, text: pending.text, score: top.score };

  const text = TEMPLATES[top.gap.id] ?? `Quick check-in: ${top.gap.topic}?`;
  const id = newId("q");
  db.prepare(
    "INSERT INTO questions (id, gap_id, text, evi_score, status) VALUES (?, ?, ?, ?, 'pending')",
  ).run(id, top.gap.id, text, top.score);
  return { id, gapId: top.gap.id, text, score: top.score };
}

/** The briefing surfaced the question out loud. */
export function markAsked(db: DatabaseSync, questionId: string, now: string): void {
  const q = db.prepare("SELECT gap_id FROM questions WHERE id = ?").get(questionId) as { gap_id: string } | undefined;
  if (!q) return;
  db.prepare("UPDATE questions SET status='asked', asked_at=? WHERE id=? AND status='pending'").run(now, questionId);
  db.prepare("UPDATE knowledge_gaps SET last_asked_at=? WHERE id=?").run(now, q.gap_id);
}

/** The user answered: store memory, close the question, raise gap confidence. */
export function recordAnswer(
  db: DatabaseSync,
  personId: string,
  questionId: string,
  content: string,
  now: string,
): { memoryId: string } {
  const q = db.prepare("SELECT gap_id FROM questions WHERE id = ?").get(questionId) as { gap_id: string } | undefined;
  const memoryId = newId("mem");
  db.prepare(
    `INSERT INTO memory_items (id, person_id, kind, content, confidence, source, question_id, status, created_at, updated_at)
     VALUES (?, ?, 'experience', ?, 0.9, 'user_said', ?, 'active', ?, ?)`,
  ).run(memoryId, personId, content, questionId, now, now);
  db.prepare("UPDATE questions SET status='answered', answer_memory_id=? WHERE id=?").run(memoryId, questionId);
  if (q) db.prepare("UPDATE knowledge_gaps SET confidence=0.9 WHERE id=?").run(q.gap_id);
  return { memoryId };
}
