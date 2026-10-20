/** Memory hygiene: repeating a preference must not store it twice. */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db/schema.js";
import { seed, DEMO_TODAY } from "../src/db/seed.js";
import { remember, reviewMemory } from "../src/tools/impl.js";

describe("remember", () => {
  it("dedupes the same preference said twice (punctuation and 'actually' ignored)", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    seed(db);
    const before = (reviewMemory(db).data as { memories: unknown[] }).memories.length;
    const first = remember(db, DEMO_TODAY, "Actually, I hate morning gym", "preference");
    const second = remember(db, DEMO_TODAY, "i hate morning gym!", "preference");
    expect(first.data).toMatchObject({ kind: "preference" });
    expect(second.data).toMatchObject({ memory_id: (first.data as { memory_id: string }).memory_id, duplicate: true });
    expect(second.text).toMatch(/already noted/i);
    expect((reviewMemory(db).data as { memories: unknown[] }).memories.length).toBe(before + 1);
  });
});

describe("review_memory", () => {
  it("summarizes stored memories by category, from what the user said, without inventing anything", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    seed(db);
    remember(db, DEMO_TODAY, "Actually, I hate morning gym", "preference");
    const out = reviewMemory(db);
    expect(out.text).toMatch(/^Here's what I know about you — 7 things you've told me\./);
    expect(out.text).toMatch(/Preferences: I hate morning gym; Values ranking/);
    expect(out.text).toMatch(/Facts: Married to Sam; two kids: Maya \(8\) and Leo \(5\)/);
    expect(out.text).toMatch(/Commitments: Saving \$500\/month/);
    expect(out.text).toMatch(/Recent check-ins: /);
    expect(out.text).not.toMatch(/inferred/i);
    expect(out.text).toMatch(/Say "forget"/);
    // Every sentence in the summary is a stored memory, verbatim-cleaned.
    const stored = (out.data as { memories: Array<{ content: string }> }).memories.map((m) => m.content);
    for (const frag of ["I hate morning gym", "Married to Sam", "Saving $500/month"]) expect(stored.some((c) => c.includes(frag))).toBe(true);
  });

  it("labels engine inferences separately as unconfirmed", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    seed(db);
    db.prepare(
      `INSERT INTO memory_items (id, person_id, kind, content, confidence, source, question_id, status, created_at, updated_at)
       VALUES ('mem_h1','alex','hypothesis','Work evenings are displacing family time.',0.6,'engine_inferred',NULL,'active','2026-10-19T09:00:00Z','2026-10-19T09:00:00Z')`,
    ).run();
    const out = reviewMemory(db);
    expect(out.text).toMatch(/6 things you've told me and 1 I've inferred but not confirmed/);
    expect(out.text).toMatch(/Inferred, unconfirmed: Work evenings are displacing family time\./);
  });
});

describe("goal notes", () => {
  it("stores a wish as a goal_note and lists it under 'About your goals'", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    seed(db);
    const r = remember(db, DEMO_TODAY, "I want a better relationship with my wife", "goal_note");
    expect(r.text).toMatch(/^Kept as something you want/);
    expect(reviewMemory(db).text).toMatch(/About your goals: I want a better relationship with my wife\./);
    expect(remember(db, DEMO_TODAY, "i want a better relationship with my wife!", "goal_note").data).toMatchObject({ duplicate: true });
  });
});
