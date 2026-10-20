/**
 * Seed dataset: demo persona "Alex".
 *
 * Anchored at LIFEOS_DEMO_TODAY (default 2026-10-19, a Monday).
 * Three weeks of history + the CURRENT week pre-filled (forward-scan material).
 *
 * The data is engineered so every detector fires:
 *  - G1 goal deficit: gym 1/3 last week, Spanish 0/3, date night 0/1, call-mom 0/1
 *  - G2 neglect: no date night in 25 days; no "Call Mom" in 17 days
 *  - G3 attention drift: stated ranking puts marriage/family first; time says work
 *  - G4 evening creep: 4 work events past 18:30 last week
 *  - G5 postponement: "Quarterly report" rescheduled 4 times
 *  - G6 trend/staleness: weekly adherence declines over 3 weeks; friends domain has no fresh signal
 *
 * Completion evidence: the fixture asserts that every PAST seeded event happened
 * (completion='done', source='seed') — that is the persona's imported history,
 * not an inference. This week's events are 'scheduled'. Plan-created events
 * start 'scheduled' and only become 'done'/'missed' through a user check-in.
 *  - G7 finance pacing: $500/mo house-fund goal, October progress unknown
 *  - G8 forward scan: THIS week has 0 gym/Spanish/date slots + a Thu collision
 *    (Client workshop 17:00–18:30 vs School recital 18:00–19:30)
 */
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { openDb, migrate, TABLES } from "./schema.js";
import { seedIdFactory } from "../core/ids.js";

export const DEMO_TODAY = process.env.LIFEOS_DEMO_TODAY ?? "2026-10-19";
export const PERSON_ID = "alex";

const pad = (n: number) => String(n).padStart(2, "0");

/** Build a local-naive ISO timestamp `off` days from the anchor Monday. */
function dayAt(off: number, hh: number, mm = 0): string {
  const [y, m, d] = DEMO_TODAY.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d) + off * 86_400_000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(hh)}:${pad(mm)}:00`;
}

type Ev = [title: string, domain: string, off: number, sh: number, sm: number, eh: number, em: number, flexible?: number, resched?: number];

// Week offsets: histA = -21 (3 wks ago), histB = -14, histC = -7 (last week), this week = 0.
const EVENTS: Ev[] = [
  // ---- 25 days ago: the last date night (outside the 21-day window → G2 fires)
  ["Date night with Sam", "family", -25, 19, 30, 22, 0],

  // ---- histA (3 weeks ago): the "good baseline" week
  ["Gym", "health", -21, 7, 0, 8, 0],
  ["Team sync", "work", -21, 10, 0, 11, 0],
  ["Deep work", "work", -21, 13, 0, 15, 0, 1],
  ["Spanish practice", "personal", -20, 7, 30, 8, 0],
  ["Product review", "work", -20, 10, 0, 12, 0],
  ["Gym", "health", -19, 7, 0, 8, 0],
  ["Project review", "work", -19, 14, 0, 15, 30],
  ["Spanish practice", "personal", -18, 7, 30, 8, 0],
  ["Client call", "work", -18, 16, 0, 17, 0],
  ["Sprint planning overflow", "work", -18, 17, 30, 19, 0], // mild single overrun
  ["Call Mom", "family", -17, 17, 0, 17, 30], // last call-mom, 17 days ago
  ["Groceries run", "household", -16, 10, 0, 11, 0], // household goal: done 3 weeks ago…
  ["Family dinner", "family", -17, 18, 30, 20, 0],

  // ---- histB (2 weeks ago): decline begins
  ["Gym", "health", -14, 7, 0, 8, 0],
  ["Sprint planning", "work", -14, 10, 0, 12, 0],
  ["Spanish practice", "personal", -13, 7, 30, 8, 0],
  ["Roadmap workshop", "work", -13, 17, 0, 19, 30], // overrun
  ["Team 1:1s", "work", -12, 10, 0, 12, 0],
  ["Release prep", "work", -12, 17, 0, 19, 30], // overrun
  ["Incident review", "work", -11, 16, 0, 20, 0], // overrun
  ["Deep work", "work", -10, 10, 0, 12, 0, 1],
  ["Groceries run", "household", -9, 10, 0, 11, 0], // …and 2 weeks ago, then dropped

  // ---- histC (last week): the bad week — 4 evening overruns, 1 gym, nothing else
  ["Exec review", "work", -7, 17, 0, 20, 0],
  ["Customer escalation", "work", -6, 16, 0, 19, 30],
  ["All-hands prep", "work", -5, 17, 0, 20, 0],
  ["Board deck", "work", -4, 16, 30, 19, 45],
  ["Gym", "health", -3, 7, 0, 8, 0],
  ["Deep work", "work", -3, 10, 0, 12, 0, 1],

  // ---- THIS week (pre-filled: what G8 forward-scans)
  ["Standup", "work", 0, 9, 0, 9, 30],
  ["Deep work", "work", 0, 10, 0, 12, 0, 1],
  ["Partner meeting", "work", 0, 14, 0, 15, 0],
  ["Deep work", "work", 1, 10, 0, 12, 0, 1],
  ["Quarterly planning", "work", 1, 15, 0, 17, 0],
  ["Quarterly report writing", "work", 2, 15, 0, 17, 0, 1, 4], // G5: moved 4 times
  ["Client workshop", "work", 3, 17, 0, 18, 30, 1], // movable ↓ G8 collision pair
  ["School recital — Maya", "family", 3, 18, 0, 19, 30],
  ["Deep work", "work", 4, 10, 0, 12, 0, 1],
];

/**
 * Blank mind: a brand-new user. Everything wiped; Align knows nothing and
 * must learn the person's life through the onboarding interview.
 */
export function blankStart(db: DatabaseSync): void {
  for (const t of TABLES) db.exec(`DELETE FROM ${t};`);
  db.prepare("INSERT INTO people (id, name, quiet_hours) VALUES (?, ?, ?)").run(PERSON_ID, "", "22:00-07:00");
}

export function seed(db: DatabaseSync): void {
  for (const t of TABLES) db.exec(`DELETE FROM ${t};`);
  const id = seedIdFactory();
  const now = dayAt(0, 7, 0);

  db.prepare("INSERT INTO people (id, name, quiet_hours) VALUES (?, ?, ?)").run(
    PERSON_ID, "Alex", "22:00-07:00",
  );

  const insEv = db.prepare(
    `INSERT INTO events (id, person_id, title, start, end, domain, flexible, source, reschedule_count, completion, completion_source, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'seed', ?, ?, ?, ?)`,
  );
  for (const [title, domain, off, sh, sm, eh, em, flex = 0, resched = 0] of EVENTS) {
    const past = off < 0;
    insEv.run(id("evt"), PERSON_ID, title, dayAt(off, sh, sm), dayAt(off, eh, em), domain, flex, resched,
      past ? "done" : "scheduled", past ? "seed" : null, past ? dayAt(off, eh, em) : null);
  }

  const insGoal = db.prepare(
    `INSERT INTO goals (id, person_id, domain, title, cadence_per_week, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`,
  );
  const goals: Array<[string, string, string, number]> = [
    ["goal_date", "family", "Date night with Sam", 1],
    ["goal_gym", "health", "Gym", 3],
    ["goal_spanish", "personal", "Spanish practice", 3],
    ["goal_mom", "family", "Call Mom", 1],
    ["goal_house", "finance", "Save $500/month toward the house fund", 1],
    ["goal_groceries", "household", "Groceries run", 1],
  ];
  for (const [gid, domain, title, cadence] of goals) {
    insGoal.run(gid, PERSON_ID, domain, title, cadence, dayAt(-30, 9, 0));
  }

  const insMem = db.prepare(
    `INSERT INTO memory_items (id, person_id, kind, content, confidence, source, question_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  );
  const mem = (kind: string, content: string, conf = 1.0, qid: string | null = null, at = dayAt(-30, 9, 0)) =>
    insMem.run(id("mem"), PERSON_ID, kind, content, conf, "seed", qid, at, at);

  mem("fact", "Married to Sam; two kids: Maya (8) and Leo (5).");
  mem("preference", "Values ranking: 1) marriage & family 2) health 3) personal growth 4) career 5) finances 6) household.");
  mem("preference", "Mornings are best for focused/personal activities; evenings belong to family.");
  mem("commitment", "Saving $500/month toward a house down payment (the 'house fund').");
  mem("experience", "Felt great after morning gym sessions three weeks ago.", 0.9, null, dayAt(-19, 8, 10));
  // From an answered question 10 days ago (shows cooldown + answer→memory linkage):
  mem("experience", "Had dinner with Omar last week; wants to see friends more often.", 0.9, "q_001", dayAt(-10, 19, 0));

  // Knowledge gaps are DISCOVERED by the engine, not seeded. The one seeded row
  // is history: a gap that was asked and answered 10 days ago (cooldown + answer→memory linkage).
  db.prepare(
    `INSERT INTO knowledge_gaps (id, person_id, topic, domain, blocked_insight_id, confidence, sensitive, last_asked_at, declines, kind, evidence, importance, status, decision_ref, source, created_at, resolved_at)
     VALUES ('gap_friends', ?, 'Time with friends lately', 'personal', NULL, 0.9, 0, ?, 0, 'stale', '{}', 0.6, 'resolved', 'balance:personal', 'seed', ?, ?)`,
  ).run(PERSON_ID, dayAt(-10, 18, 0), dayAt(-10, 18, 0), dayAt(-10, 19, 0));

  db.prepare(
    `INSERT INTO questions (id, gap_id, text, evi_score, status, asked_at, answer_memory_id)
     VALUES ('q_001', 'gap_friends', 'Have you managed to see friends lately?', 0.55, 'answered', ?, ?)`,
  ).run(dayAt(-10, 18, 0), "mem_006");
}

export function summarize(db: DatabaseSync): string {
  const count = (t: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  return TABLES.map((t) => `${t}=${count(t)}`).join(" ");
}

// Run directly: `npm run seed`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const db = openDb();
  migrate(db);
  seed(db);
  console.log(`Seeded (anchor ${DEMO_TODAY}): ${summarize(db)}`);
}
