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
  "goal_logs",
  "engine_runs",
  "kv",
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
  hypothesis TEXT,
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

CREATE TABLE IF NOT EXISTS goal_logs (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  at TEXT NOT NULL,
  value REAL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS engine_runs (
  id TEXT PRIMARY KEY,
  ran_at TEXT NOT NULL,
  summary TEXT
);

-- Small durable settings (e.g. the day a plan was last offered). Additive: created if absent.
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(path?: string): DatabaseSync {
  const file = path ?? process.env.LIFEOS_DB ?? "data/lifeos.db";
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  return db;
}

/**
 * Additive forward migrations. Every column has a default, so rows written by
 * older versions keep working and an older build can still read the file
 * (rollback = run the previous code; nothing is dropped or rewritten).
 */
const MIGRATIONS: string[] = [
  "ALTER TABLE plans ADD COLUMN hypothesis TEXT",
  // Intelligence 2.0 — completion evidence, honest outcomes, discovered gaps.
  "ALTER TABLE events ADD COLUMN completion TEXT NOT NULL DEFAULT 'unknown'", // scheduled | done | missed | unknown
  "ALTER TABLE events ADD COLUMN completion_source TEXT",                       // user_said | seed | null
  "ALTER TABLE events ADD COLUMN completed_at TEXT",
  "ALTER TABLE knowledge_gaps ADD COLUMN kind TEXT NOT NULL DEFAULT 'unknown'", // unknown | contradiction | stale
  "ALTER TABLE knowledge_gaps ADD COLUMN evidence TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE knowledge_gaps ADD COLUMN importance REAL NOT NULL DEFAULT 0.5",
  "ALTER TABLE knowledge_gaps ADD COLUMN status TEXT NOT NULL DEFAULT 'open'",  // open | resolved | declined
  "ALTER TABLE knowledge_gaps ADD COLUMN decision_ref TEXT",
  "ALTER TABLE knowledge_gaps ADD COLUMN source TEXT NOT NULL DEFAULT 'seed'",  // seed | engine
  "ALTER TABLE knowledge_gaps ADD COLUMN created_at TEXT",
  "ALTER TABLE knowledge_gaps ADD COLUMN resolved_at TEXT",
  "ALTER TABLE questions ADD COLUMN reason TEXT",
  "ALTER TABLE outcomes ADD COLUMN scheduled REAL",
  "ALTER TABLE outcomes ADD COLUMN confirmed REAL",
  "ALTER TABLE outcomes ADD COLUMN missed REAL",
  "ALTER TABLE outcomes ADD COLUMN unknown REAL",
  "ALTER TABLE outcomes ADD COLUMN data_completeness REAL",
  "ALTER TABLE outcomes ADD COLUMN window_start TEXT",
  "ALTER TABLE outcomes ADD COLUMN window_end TEXT",
  "ALTER TABLE outcomes ADD COLUMN attribution TEXT NOT NULL DEFAULT 'association'",
  "ALTER TABLE memory_items ADD COLUMN supersedes_id TEXT",
  // Anti-nagging: what the gap's evidence looked like when the question was asked.
  "ALTER TABLE questions ADD COLUMN asked_evidence TEXT",
];

export function migrate(db: DatabaseSync): void {
  db.exec(DDL);
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch {
      /* column already exists */
    }
  }
}
