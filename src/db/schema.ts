import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const TABLES = [
  "people",
  "events",
  "goals",
  "memory_items",
  "insights",
  "knowledge_gaps",
  "questions",
  "plans",
  "action_log",
  "outcomes",
  "engine_runs",
] as const;

const DDL = `
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  quiet_hours TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  title TEXT NOT NULL,
  start TEXT NOT NULL,
  end TEXT NOT NULL,
  domain TEXT NOT NULL CHECK(domain IN ('work','family','health','personal','household','admin')),
  flexible INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'seed',
  reschedule_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  title TEXT NOT NULL,
  cadence_per_week INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('fact','preference','goal_note','experience','pattern','hypothesis','commitment','outcome')),
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL,
  question_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS insights (
  id TEXT PRIMARY KEY,
  detectors TEXT NOT NULL,
  domains TEXT NOT NULL,
  severity INTEGER NOT NULL,
  title TEXT NOT NULL,
  evidence TEXT NOT NULL,
  reasoning TEXT,
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_gaps (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  domain TEXT NOT NULL,
  blocked_insight_id TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  sensitive INTEGER NOT NULL DEFAULT 0,
  last_asked_at TEXT,
  declines INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  gap_id TEXT NOT NULL,
  text TEXT NOT NULL,
  evi_score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  asked_at TEXT,
  answer_memory_id TEXT
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  insight_id TEXT NOT NULL,
  title TEXT NOT NULL,
  changes TEXT NOT NULL,
  tradeoffs TEXT,
  expected_benefit TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  approved_at TEXT,
  executed_at TEXT
);

CREATE TABLE IF NOT EXISTS action_log (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  op TEXT NOT NULL,
  payload TEXT NOT NULL,
  executed_at TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  verification_detail TEXT
);

CREATE TABLE IF NOT EXISTS outcomes (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  baseline REAL,
  observed REAL,
  measured_at TEXT NOT NULL,
  verdict TEXT
);

CREATE TABLE IF NOT EXISTS engine_runs (
  id TEXT PRIMARY KEY,
  ran_at TEXT NOT NULL,
  summary TEXT
);
`;

export function openDb(path?: string): DatabaseSync {
  const file = path ?? process.env.LIFEOS_DB ?? "data/lifeos.db";
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(DDL);
}
