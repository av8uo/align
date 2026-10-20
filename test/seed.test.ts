/**
 * These tests pin the DEMO PRECONDITIONS: if they pass, every detector in the
 * engine has real material to find and the demo script's beats are guaranteed.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db/schema.js";
import { seed, DEMO_TODAY, PERSON_ID } from "../src/db/seed.js";

let db: DatabaseSync;

function dayOffset(off: number): string {
  const [y, m, d] = DEMO_TODAY.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d) + off * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

beforeAll(() => {
  db = new DatabaseSync(":memory:");
  migrate(db);
  seed(db);
});

describe("seed demo preconditions", () => {
  it("has the persona, 5 goals across >=4 domains, and seeded memory", () => {
    const person = db.prepare("SELECT * FROM people WHERE id=?").get(PERSON_ID);
    expect(person).toBeTruthy();
    const goals = db.prepare("SELECT domain FROM goals WHERE person_id=?").all(PERSON_ID) as Array<{ domain: string }>;
    expect(goals.length).toBe(6);
    expect(new Set(goals.map((g) => g.domain)).size).toBeGreaterThanOrEqual(4);
    const kinds = db.prepare("SELECT DISTINCT kind FROM memory_items").all() as Array<{ kind: string }>;
    for (const k of ["fact", "preference", "commitment", "experience"]) {
      expect(kinds.map((r) => r.kind)).toContain(k);
    }
  });

  it("G4 evening creep: >=3 work events past 18:30 last week", () => {
    const rows = db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
         WHERE domain='work' AND start >= ? AND start < ? AND time(end) > '18:30:00'`,
      )
      .get(dayOffset(-7), dayOffset(0)) as { n: number };
    expect(rows.n).toBeGreaterThanOrEqual(3);
  });

  it("G1 goal deficit: last week had 1 gym, 0 Spanish, 0 date night", () => {
    const n = (title: string) =>
      (db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE title LIKE ? AND start >= ? AND start < ?`)
        .get(`%${title}%`, dayOffset(-7), dayOffset(0)) as { n: number }).n;
    expect(n("Gym")).toBe(1);
    expect(n("Spanish")).toBe(0);
    expect(n("Date night")).toBe(0);
  });

  it("G2 neglect: no date night and no Call Mom within the last 14 days", () => {
    const n = (title: string) =>
      (db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE title LIKE ? AND start >= ?`)
        .get(`%${title}%`, dayOffset(-14)) as { n: number }).n;
    expect(n("Date night")).toBe(0);
    expect(n("Call Mom")).toBe(0);
  });

  it("G5 postponement: an event rescheduled >=3 times exists", () => {
    const row = db
      .prepare("SELECT title, reschedule_count FROM events WHERE reschedule_count >= 3")
      .get() as { title: string; reschedule_count: number } | undefined;
    expect(row?.title).toBe("Quarterly report writing");
  });

  it("G8 forward scan: this week has 0 gym/Spanish/date slots and a Thu work-family collision", () => {
    const n = (title: string) =>
      (db
        .prepare(`SELECT COUNT(*) AS n FROM events WHERE title LIKE ? AND start >= ? AND start < ?`)
        .get(`%${title}%`, dayOffset(0), dayOffset(7)) as { n: number }).n;
    expect(n("Gym") + n("Spanish") + n("Date night")).toBe(0);

    const collision = db
      .prepare(
        `SELECT COUNT(*) AS n FROM events a JOIN events b
           ON a.domain='work' AND b.domain='family'
          AND a.start < b.end AND b.start < a.end
        WHERE a.start >= ? AND a.start < ?`,
      )
      .get(dayOffset(0), dayOffset(7)) as { n: number };
    expect(collision.n).toBeGreaterThanOrEqual(1);
  });

  it("knowledge gaps are not seeded — only one resolved historical gap with its answered question", () => {
    const gaps = db.prepare("SELECT id, status, source FROM knowledge_gaps").all() as Array<{ id: string; status: string; source: string }>;
    expect(gaps).toEqual([{ id: "gap_friends", status: "resolved", source: "seed" }]);
    const q = db.prepare("SELECT * FROM questions WHERE id='q_001'").get() as {
      status: string;
      answer_memory_id: string;
    };
    expect(q.status).toBe("answered");
    const linked = db.prepare("SELECT question_id FROM memory_items WHERE id=?").get(q.answer_memory_id) as
      | { question_id: string }
      | undefined;
    expect(linked?.question_id).toBe("q_001");
  });

  it("plan-solver material: this week has flexible blocks to move", () => {
    const rows = db
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE flexible=1 AND start >= ? AND start < ?`)
      .get(dayOffset(0), dayOffset(7)) as { n: number };
    expect(rows.n).toBeGreaterThanOrEqual(3);
  });

  it("seed is idempotent", () => {
    seed(db);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n;
    expect(n).toBe(1);
  });
});
