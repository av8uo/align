/**
 * "Since we last spoke" — what the proactive opening may pick up from. Read
 * from the durable store (not the browser session), so the thread survives a
 * reload or a week passing: what the user told Align, and the last plan applied.
 */
import type { DatabaseSync } from "node:sqlite";
import { addDays, dayStart } from "../engine/time.js";

export interface Recall {
  said: string[]; // the user's own recent statements, newest first
  plan: { title: string; changes: number; executedOn: string } | null;
}

export function sinceLastTime(db: DatabaseSync, today: string, personId = "alex"): Recall {
  const from = dayStart(addDays(today, -21));
  const said = (db
    .prepare(
      `SELECT content FROM memory_items WHERE person_id=? AND status='active' AND source='user_said'
         AND kind IN ('preference','fact','experience') AND created_at >= ? ORDER BY created_at DESC LIMIT 3`,
    )
    .all(personId, from) as Array<{ content: string }>).map((m) => m.content);
  const p = db
    .prepare("SELECT title, changes, executed_at FROM plans WHERE status IN ('verified','applied','executed') AND executed_at >= ? ORDER BY executed_at DESC LIMIT 1")
    .get(from) as { title: string; changes: string; executed_at: string } | undefined;
  let changes = 0;
  try { changes = p ? (JSON.parse(p.changes) as unknown[]).length : 0; } catch { /* unreadable: count unknown */ }
  return { said, plan: p ? { title: p.title, changes, executedOn: p.executed_at.slice(0, 10) } : null };
}

/** The recall as instruction lines for the host, or "" when there is nothing to pick up. */
export function renderRecall(r: Recall): string {
  const lines = [
    ...r.said.map((s) => `- They told you: "${s}"`),
    ...(r.plan ? [`- You applied a plan together on ${r.plan.executedOn}: "${r.plan.title}" (${r.plan.changes} changes)`] : []),
  ];
  return lines.length ? `\n\nSince you last spoke (pick up the thread from ONE of these):\n${lines.join("\n")}` : "";
}
