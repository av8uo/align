/**
 * Conversational evaluation suite — fixed multi-turn scenarios A–L through the
 * real HTTP server and the deterministic rules brain (so results are
 * reproducible). Each scenario checks BEHAVIOR and STATE, not helper functions.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { migrate } from "../src/db/schema.js";
import { seed, DEMO_TODAY } from "../src/db/seed.js";
import { createLifeOsHttpServer } from "../src/server.js";

type Reply = { reply: string; toolCalls: Array<{ name: string; args: Record<string, unknown>; data?: Record<string, unknown>; isError: boolean }>; brain: string };

function boot(db: DatabaseSync) {
  const server = createLifeOsHttpServer(db, DEMO_TODAY);
  return new Promise<{ server: typeof server; base: string }>((resolve) =>
    server.listen(0, () => resolve({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })),
  );
}
const talk = (base: string, sid: string) => async (text: string): Promise<Reply> =>
  (await fetch(`${base}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sid, text }) })).json() as Promise<Reply>;
const proactive = async (base: string, sid: string) => (await fetch(`${base}/proactive?session_id=${sid}`)).json() as Promise<{ quiet: boolean; text: string; data: { question?: { id: string; text: string } | null } }>;
const memCount = (db: DatabaseSync, kind?: string) => (db.prepare(`SELECT COUNT(*) AS n FROM memory_items WHERE status='active'${kind ? ` AND kind='${kind}'` : ""}`).get() as { n: number }).n;
const tools = (r: Reply) => r.toolCalls.map((c) => c.name);

let db: DatabaseSync;
let base: string;
let server: Awaited<ReturnType<typeof boot>>["server"];
beforeAll(async () => {
  delete process.env.LIFEOS_LLM;
  db = new DatabaseSync(":memory:");
  migrate(db);
  seed(db);
  ({ server, base } = await boot(db));
});
afterAll(() => server.close());

describe("A/B/C — preference lifecycle", () => {
  const sid = "pref";
  it("A: a new preference changes the next plan", async () => {
    const say = talk(base, sid);
    await proactive(base, sid);
    const r = await say("I hate morning workouts.");
    expect(tools(r)).toEqual(["remember"]);
    expect(r.reply).toMatch(/gym .*evening/i);
    const plan = await say("Fix it");
    const gym = (plan.toolCalls[0]!.data as { changes: Array<{ title: string; start: string }> }).changes.filter((c) => c.title === "Gym");
    expect(gym.length).toBeGreaterThan(0);
    for (const g of gym) expect(g.start).toContain("T18:00");
  });
  it("B: the same preference again adds no memory and gets a different, shorter acknowledgement", async () => {
    const say = talk(base, sid);
    const before = memCount(db, "preference");
    const r = await say("No gym in the mornings for me.");
    expect(memCount(db, "preference")).toBe(before);
    expect(r.reply).toMatch(/already/i);
    expect(r.reply).not.toMatch(/^Noted/);
  });
  it("C: a change of mind supersedes the old preference and the next plan follows it", async () => {
    const say = talk(base, sid);
    const r = await say("Actually mornings work better for me now.");
    expect(tools(r)).toEqual(["remember"]);
    expect(r.reply).toMatch(/^Updated/);
    const old = db.prepare("SELECT status FROM memory_items WHERE content='I hate morning workouts.'").get() as { status: string };
    expect(old.status).toBe("corrected");
    const plan = await say("Fix it");
    const gym = (plan.toolCalls[0]!.data as { changes: Array<{ title: string; start: string }> }).changes.filter((c) => c.title === "Gym");
    for (const g of gym) expect(g.start).toContain("T07:00");
  });
});

describe("D — goal change reconsiders the plan", () => {
  it("updating the gym target sets the pending plan aside and the next plan uses the new cadence", async () => {
    const say = talk(base, "goal");
    await proactive(base, "goal");
    await say("Fix it");
    const r = await say("Change my gym goal to 2 times a week");
    expect(tools(r)).toEqual(["get_goal_progress", "set_goal"]);
    expect(r.reply).toMatch(/now 2× per week, was 3/);
    expect(r.reply).toMatch(/set it aside/);
    const yes = await say("Yes, do it");
    expect(tools(yes)).toEqual([]); // nothing pending anymore
    expect((db.prepare("SELECT cadence_per_week FROM goals WHERE id='goal_gym'").get() as { cadence_per_week: number }).cadence_per_week).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS n FROM goals WHERE title='Gym'").get() as { n: number }).n).toBe(1); // no duplicate goal
    const plan = await say("Fix it");
    const gym = (plan.toolCalls[0]!.data as { changes: Array<{ title: string }> }).changes.filter((c) => c.title === "Gym");
    expect(gym.length).toBe(2);
  });
});

describe("E — asked-and-answered questions are not repeated", () => {
  it("after the answer, neither the proactive channel nor 'what do you want to know' repeats the question", async () => {
    const db2 = new DatabaseSync(":memory:");
    migrate(db2);
    seed(db2);
    const { server: s2, base: b2 } = await boot(db2);
    try {
      const say = talk(b2, "e");
      const first = await proactive(b2, "e");
      expect(first.data.question?.text).toContain("Sam");
      await say("Honestly we barely talk, work is eating everything.");
      const again = await proactive(b2, "e");
      expect(again.quiet).toBe(true);
      const want = await say("What do you want to know about me?");
      expect(want.reply).not.toContain("Sam");
      const asked = db2.prepare("SELECT COUNT(*) AS n FROM questions WHERE text LIKE '%Sam%' AND status IN ('asked','answered','pending')").get() as { n: number };
      expect(asked.n).toBe(1);
      const complaint = await say("You asked me that already");
      expect(tools(complaint)).toEqual([]);
      expect(complaint.reply).toMatch(/stop repeating|already asked/i);
    } finally {
      s2.close();
    }
  });
});

describe("F — support request", () => {
  it("acknowledges the user's own words, calls no tool, offers no intervention", async () => {
    const r = await talk(base, "support")("I'm exhausted and I feel like I'm failing at everything.");
    expect(tools(r)).toEqual([]);
    expect(r.reply).toContain("i'm exhausted and I feel like I'm failing at everything");
    expect(r.reply).not.toMatch(/fix it/i);
    expect(r.reply).not.toMatch(/sorry/i); // no scripted sympathy
  });
});

describe("G — ambiguous completion statements never mark anything done", () => {
  it("hedges keep the question open; only a clear answer records evidence", async () => {
    const db3 = new DatabaseSync(":memory:");
    migrate(db3);
    seed(db3);
    const { server: s3, base: b3 } = await boot(db3);
    try {
      const say = talk(b3, "g");
      await proactive(b3, "g");
      await say("Fix it");
      await say("Yes, do it");
      await fetch(`${b3}/demo/advance`, { method: "POST" });
      const wk = await proactive(b3, "g");
      // Family was asked about last week, so the question rotates to another area.
      expect(wk.data.question?.text).toMatch(/^Last week I scheduled gym 3 times/);
      const marks = () => (db3.prepare("SELECT COUNT(*) AS n FROM events WHERE completion_source='user_said'").get() as { n: number }).n;
      const a = await say("It was a weird week");
      expect(tools(a)).toEqual([]);
      expect(marks()).toBe(0);
      const b = await say("I think I went once or twice, not sure");
      expect(marks()).toBe(0);
      expect(b.reply).toMatch(/yes, a no, or a number|couldn't tell|leave it unrecorded/i); // second hedge: no repeated sentence, still nothing recorded
      const c = await say("Yes, all three");
      expect(marks()).toBe(3);
      expect(c.reply).toMatch(/recorded that as done/);
    } finally {
      s3.close();
    }
  });
});

describe("H — corrections are used afterwards", () => {
  it("'X, not Y' retires the fact that said Y, and memory review reflects it", async () => {
    const say = talk(base, "h");
    const r1 = await say("My wife's name is Samantha.");
    expect(tools(r1)).toEqual(["remember"]);
    const r2 = await say("My wife's name is Sam, not Samantha.");
    expect(r2.reply).toMatch(/^Corrected/);
    const rows = db.prepare("SELECT content, status FROM memory_items WHERE content LIKE '%wife%' ORDER BY created_at").all() as Array<{ content: string; status: string }>;
    expect(rows.map((r) => r.status)).toEqual(["corrected", "active"]);
    const review = await say("What do you know about me?");
    expect(review.reply).toContain("Sam, not Samantha");
    expect(review.reply).not.toContain("name is Samantha.");
  });
});

describe("I/J — restarts", () => {
  it("I: durable facts survive a server restart; J: a new session has no conversational context but all the memory", async () => {
    const dbR = new DatabaseSync(":memory:");
    migrate(dbR);
    seed(dbR);
    let boot1 = await boot(dbR);
    const say1 = talk(boot1.base, "first");
    const q = await proactive(boot1.base, "first");
    await say1("Leo has football on Wednesdays.");
    await say1("Honestly we barely talk, work is eating everything.");
    boot1.server.close();
    const boot2 = await boot(dbR); // server restart, same database file
    try {
      const say2 = talk(boot2.base, "second"); // new session
      const review = await say2("What do you know about me?");
      expect(review.reply).toContain("Leo has football on Wednesdays");
      expect(review.reply).toContain("we barely talk");
      // Conversational context did not leak: no open question, no pending plan, no repeated question.
      const p = await proactive(boot2.base, "second");
      expect(p.quiet).toBe(true);
      const yes = await say2("Yes");
      expect(tools(yes)).toEqual([]);
      expect(yes.reply).toMatch(/Nothing is waiting on a yes/);
      expect(q.data.question).toBeTruthy();
      expect((dbR.prepare("SELECT status FROM questions WHERE id=?").get(q.data.question!.id) as { status: string }).status).toBe("answered");
    } finally {
      boot2.server.close();
    }
  });
});

describe("K — approval and rejection", () => {
  it("reject records, approve executes once, a second yes executes nothing", async () => {
    const dbK = new DatabaseSync(":memory:");
    migrate(dbK);
    seed(dbK);
    const { server: sK, base: bK } = await boot(dbK);
    try {
      const say = talk(bK, "k");
      await proactive(bK, "k");
      await say("Fix it");
      const no = await say("Not now");
      expect(tools(no)).toEqual(["apply_plan"]);
      expect((dbK.prepare("SELECT status FROM plans ORDER BY rowid DESC LIMIT 1").get() as { status: string }).status).toBe("rejected");
      const events0 = (dbK.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
      await say("Fix it");
      const yes = await say("Yes, do it");
      expect(tools(yes)).toEqual(["apply_plan"]);
      const events1 = (dbK.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
      expect(events1).toBeGreaterThan(events0);
      const again = await say("Yes, do it");
      expect(tools(again)).toEqual([]);
      expect((dbK.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(events1);
    } finally {
      sK.close();
    }
  });
});

describe("L — LLM unavailable", () => {
  it("the fallback stays useful and never pretends to be the LLM", async () => {
    const saved = { llm: process.env.LIFEOS_LLM, key: process.env.ANTHROPIC_API_KEY };
    process.env.LIFEOS_LLM = "anthropic";
    delete process.env.ANTHROPIC_API_KEY;
    const dbL = new DatabaseSync(":memory:");
    migrate(dbL);
    seed(dbL);
    const { server: sL, base: bL } = await boot(dbL);
    try {
      const health = (await (await fetch(`${bL}/healthz`)).json()) as { brain: string; llm: { configured: boolean } };
      expect(health.brain).toBe("anthropic");
      expect(health.llm.configured).toBe(false);
      const say = talk(bL, "l");
      const r = await say("How's my week looking?");
      expect(r.brain).toBe("rules");
      expect(tools(r)).toEqual(["get_daily_briefing"]);
      expect(r.reply).toContain("Work is crowding");
    } finally {
      sL.close();
      if (saved.llm !== undefined) process.env.LIFEOS_LLM = saved.llm; else delete process.env.LIFEOS_LLM;
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
    }
  });
});
