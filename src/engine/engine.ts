/**
 * The nightly Life Intelligence Engine.
 * Runs without any prompt: detect → correlate → measure outcomes → choose the
 * one question worth asking → leave everything precomputed so every MCP tool
 * answers in milliseconds.
 */
import type { DatabaseSync } from "node:sqlite";
import type { EventRow, GoalRow, MemoryRow } from "../core/types.js";
import { newId } from "../core/ids.js";
import { runDetectors, type Ctx } from "./detectors.js";
import { lifeBalance, g3AttentionDrift, type DomainScore } from "./balance.js";
import { correlate, upsertInsights } from "./correlate.js";
import { pickQuestion } from "./inquiry.js";
import { measureOutcomes } from "./learn.js";

export interface EngineSummary {
  ranAt: string;
  insightIds: string[];
  balance: DomainScore[];
  question: { id: string; gapId: string; text: string; score: number } | null;
  outcomesMeasured: Array<{ metric: string; verdict: string }>;
}

export function loadCtx(db: DatabaseSync, today: string, personId = "alex"): Ctx {
  return {
    today,
    events: db.prepare("SELECT * FROM events WHERE person_id = ?").all(personId) as unknown as EventRow[],
    goals: db.prepare("SELECT * FROM goals WHERE person_id = ?").all(personId) as unknown as GoalRow[],
    memory: db
      .prepare("SELECT * FROM memory_items WHERE person_id = ? AND status='active'")
      .all(personId) as unknown as MemoryRow[],
    goalLogs: db.prepare("SELECT goal_id, at, value FROM goal_logs").all() as Array<{
      goal_id: string;
      at: string;
      value: number | null;
    }>,
  };
}

export function runEngine(db: DatabaseSync, today: string, personId = "alex"): EngineSummary {
  const now = `${today}T07:00:00`;
  const ctx = loadCtx(db, today, personId);

  const balance = lifeBalance(ctx);
  const findings = [...runDetectors(ctx), ...g3AttentionDrift(ctx, balance)];
  const insightIds = upsertInsights(db, correlate(ctx, findings), now);
  const outcomesMeasured = measureOutcomes(db, today);
  const question = pickQuestion(db, ctx, personId);

  db.prepare("INSERT INTO engine_runs (id, ran_at, summary) VALUES (?, ?, ?)").run(
    newId("run"),
    now,
    JSON.stringify({
      insights: insightIds.length,
      outcomes: outcomesMeasured.length,
      question: question?.id ?? null,
      balance: balance.map((b) => ({ d: b.domain, s: b.score })),
    }),
  );
  return { ranAt: now, insightIds, balance, question, outcomesMeasured };
}
