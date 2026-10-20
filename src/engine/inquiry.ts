/**
 * Proactive inquiry: pick the ONE question whose answer would most improve
 * Align's understanding (expected value of information). Deterministic scoring;
 * an LLM may rephrase the text later, never choose the question.
 */
import type { DatabaseSync } from "node:sqlite";
import { newId } from "../core/ids.js";
import { addDays, dayStart, daysBetween } from "./time.js";
import { evidenceFingerprint } from "./gaps.js";

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

/** Legacy scoring kept for reference/tests; selection now lives in gaps.ts (decision-aware). */
export function scoreGap(gap: GapRow, blockedSeverity: number, today: string): number {
  const staleness =
    gap.last_asked_at === null ? 1 : Math.min(daysBetween(gap.last_asked_at, dayStart(today)) / 21, 1);
  return 0.5 * (blockedSeverity / 3) + 0.4 * (1 - gap.confidence) + 0.1 * staleness - 0.3 * gap.declines;
}

/** The briefing surfaced the question out loud. */
export function markAsked(db: DatabaseSync, questionId: string, now: string): void {
  const q = db.prepare("SELECT gap_id FROM questions WHERE id = ?").get(questionId) as { gap_id: string } | undefined;
  if (!q) return;
  const gap = db.prepare("SELECT evidence FROM knowledge_gaps WHERE id=?").get(q.gap_id) as { evidence: string } | undefined;
  db.prepare("UPDATE questions SET status='asked', asked_at=?, asked_evidence=? WHERE id=? AND status='pending'").run(now, evidenceFingerprint(gap?.evidence), questionId);
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
  if (q) db.prepare("UPDATE knowledge_gaps SET confidence=0.9, status='resolved', resolved_at=? WHERE id=?").run(now, q.gap_id);
  return { memoryId };
}

/** The user declined to answer: counts against asking again (two declines retire the gap). */
export function recordDecline(db: DatabaseSync, questionId: string): void {
  const q = db.prepare("SELECT gap_id FROM questions WHERE id = ?").get(questionId) as { gap_id: string } | undefined;
  if (!q) return;
  db.prepare("UPDATE questions SET status='declined' WHERE id=?").run(questionId);
  db.prepare("UPDATE knowledge_gaps SET declines=declines+1 WHERE id=?").run(q.gap_id);
}

/** What decision a question informs — used to turn its answer into the right evidence. */
export function questionDecision(db: DatabaseSync, questionId: string): { gapId: string; kind: string; decisionRef: string | null; evidence: Record<string, unknown> } | null {
  const row = db
    .prepare("SELECT g.id AS gapId, g.kind, g.decision_ref, g.evidence FROM questions q JOIN knowledge_gaps g ON g.id=q.gap_id WHERE q.id=?")
    .get(questionId) as { gapId: string; kind: string; decision_ref: string | null; evidence: string } | undefined;
  return row ? { gapId: row.gapId, kind: row.kind, decisionRef: row.decision_ref, evidence: JSON.parse(row.evidence || "{}") } : null;
}
