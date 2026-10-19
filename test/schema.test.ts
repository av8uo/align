import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { migrate, TABLES } from "../src/db/schema.js";

describe("schema", () => {
  it("creates all tables", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    const names = new Set(rows.map((r) => r.name));
    for (const t of TABLES) expect(names, `missing table ${t}`).toContain(t);
  });

  it("is idempotent", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
  });

  it("rejects an invalid event domain", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db);
    expect(() =>
      db
        .prepare("INSERT INTO events (id, person_id, title, start, end, domain) VALUES ('x','p','t','a','b','nope')")
        .run(),
    ).toThrow();
  });
});
