/** Shared domain types for Align. */

export type Domain =
  | "work"
  | "family" // includes marriage & kids
  | "health"
  | "personal" // personal growth / learning
  | "household"
  | "admin"
  | "finance"; // goals only — no events, no advice (policy C4)

export type MemoryKind =
  | "fact"
  | "preference"
  | "goal_note"
  | "experience"
  | "pattern"
  | "hypothesis"
  | "commitment"
  | "outcome";

export interface EventRow {
  id: string;
  person_id: string;
  title: string;
  start: string; // local ISO, no TZ: YYYY-MM-DDTHH:MM:SS
  end: string;
  domain: Domain;
  flexible: number; // 1 = plan solver may move it
  source: "seed" | "ics" | "lifeos_plan";
  reschedule_count: number;
  /** Evidence of what actually happened. Only `done` counts as completed; `unknown` is never success or failure. */
  completion: "scheduled" | "done" | "missed" | "unknown";
  completion_source: "user_said" | "seed" | null;
  completed_at: string | null;
}

export interface GoalRow {
  id: string;
  person_id: string;
  domain: Domain;
  title: string;
  cadence_per_week: number;
  status: "active" | "paused" | "done";
  created_at: string;
}

export interface MemoryRow {
  id: string;
  person_id: string;
  kind: MemoryKind;
  content: string;
  confidence: number; // 0..1
  source: "user_said" | "engine_inferred" | "seed";
  question_id: string | null;
  status: "active" | "corrected" | "forgotten";
  created_at: string;
  updated_at: string;
  /** Set on the newer memory when it explicitly replaces an older one. */
  supersedes_id?: string | null;
}

export interface InsightRow {
  id: string; // ins_###
  detectors: string; // JSON array
  domains: string; // JSON array
  severity: number; // 1..3
  title: string;
  evidence: string; // JSON
  reasoning: string | null; // Bedrock-phrased, cached
  confidence: number;
  status: "new" | "surfaced" | "dismissed" | "actioned";
  created_at: string;
}

export interface PlanRow {
  id: string; // plan_###
  insight_id: string;
  title: string;
  changes: string; // JSON [{op, event_id?, from?, to?, create?}]
  tradeoffs: string | null;
  expected_benefit: string | null;
  status: "proposed" | "approved" | "rejected" | "executed" | "verified";
  approved_at: string | null;
  executed_at: string | null;
}
