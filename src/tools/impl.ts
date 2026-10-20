/**
 * Tool implementations: the thin layer between MCP tools and the engine.
 * Every function serves PRECOMPUTED or millisecond-cheap data — the <500ms
 * Alexa+ budget is met by doing heavy work in the nightly engine, never here.
 */
import type { DatabaseSync } from "node:sqlite";
import type { EventRow, GoalRow, MemoryRow } from "../core/types.js";
import { newId } from "../core/ids.js";
import { goalActual, keywordOf } from "../engine/detectors.js";
import { lifeBalance, type DomainScore } from "../engine/balance.js";
import { loadCtx, runEngine } from "../engine/engine.js";
import { markAsked, recordAnswer } from "../engine/inquiry.js";
import { applyPlan } from "../engine/executor.js";
import { proposePlan } from "../engine/solver.js";
import { type Change } from "../engine/learn.js";
import { addDays, fromMs, overlaps, toMs, weekdayOf } from "../engine/time.js";
import { runDetectors } from "../engine/detectors.js";

const WD = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const when = (iso: string) => `${WD[weekdayOf(iso)]} ${iso.slice(11, 16)}`;
const nowAt = (today: string) => `${today}T08:00:00`;

/**
 * Respect uncertainty out loud (vision: distinguish facts, patterns, and
 * hypotheses). Below the confidence bar, Align says so — and user answers
 * that confirm a pattern remove the hedge on the next turn.
 */
const hedge = (confidence: number, s: string): string =>
  confidence < 0.75 ? `${s} — I'm not fully sure yet, but the pattern is there` : s;

export function ensureEngineRun(db: DatabaseSync, today: string): void {
  const run = db.prepare("SELECT id FROM engine_runs WHERE ran_at LIKE ?").get(`${today}%`);
  if (!run) runEngine(db, today);
}

export interface ToolResult {
  text: string;
  data: Record<string, unknown>;
  isError?: boolean;
}

// ---------------------------------------------------------------- briefing
export function getDailyBriefing(db: DatabaseSync, today: string): ToolResult {
  ensureEngineRun(db, today);
  const balance = lifeBalance(loadCtx(db, today));
  const insights = db
    .prepare(
      "SELECT id, title, severity, domains, confidence FROM insights WHERE status IN ('new','surfaced') ORDER BY severity DESC, confidence DESC LIMIT 3",
    )
    .all() as Array<{ id: string; title: string; severity: number; domains: string; confidence: number }>;
  for (const i of insights) db.prepare("UPDATE insights SET status='surfaced' WHERE id=?").run(i.id);

  // At most ONE question per day, across all briefings (never interrogate).
  const askedToday = (db.prepare("SELECT COUNT(*) AS n FROM questions WHERE asked_at LIKE ?").get(`${today}%`) as { n: number }).n;
  const q = askedToday > 0
    ? undefined
    : (db
        .prepare("SELECT id, text FROM questions WHERE status='pending' ORDER BY evi_score DESC LIMIT 1")
        .get() as { id: string; text: string } | undefined);
  if (q) markAsked(db, q.id, nowAt(today));

  // Measured results from recently completed follow-up windows: close the loop out loud.
  const outcomes = db
    .prepare("SELECT metric, baseline, observed, verdict FROM outcomes WHERE measured_at >= ?")
    .all(addDays(today, -1)) as Array<{ metric: string; baseline: number; observed: number; verdict: string }>;
  const resultsLine =
    outcomes.length > 0
      ? `Results from last week's plan: ${outcomes
          .slice(0, 3)
          .map((o) => `${o.metric.replace("_adherence", "")} went ${o.baseline} to ${o.observed}`)
          .join(", ")}${outcomes.length > 3 ? `, and ${outcomes.length - 3} more` : ""} — ${
          outcomes.every((o) => o.verdict === "improved") ? "all improved." : "mostly better."
        }`
      : "";

  // Streak celebrations: momentum made audible (≥2 weeks), and "back on track"
  // revivals (hit last week after missing the week before).
  const ctx = loadCtx(db, today);
  let streakLine = "";
  const streaks: Array<{ goal: string; weeks: number; revived: boolean }> = [];
  for (const g of ctx.goals.filter((x) => x.status === "active" && x.domain !== "finance")) {
    let weeks = 0;
    for (let k = 1; k <= 8; k++) {
      if (goalActual(ctx.events, g, addDays(today, -7 * k), addDays(today, -7 * (k - 1))) >= g.cadence_per_week) weeks++;
      else break;
    }
    const missedBefore =
      goalActual(ctx.events, g, addDays(today, -14), addDays(today, -7)) < g.cadence_per_week;
    if (weeks >= 1) streaks.push({ goal: keywordOf(g.title), weeks, revived: weeks === 1 && missedBefore });
  }
  const best = streaks.sort((a, b) => b.weeks - a.weeks)[0];
  const revived = streaks.find((s) => s.revived);
  if (best && best.weeks >= 2) streakLine = `${best.weeks} weeks in a row on your ${best.goal} goal — keep it going.`;
  else if (revived) streakLine = `${revived.goal[0]!.toUpperCase()}${revived.goal.slice(1)} is back on track after missing a week.`;

  // A second insight is spoken only if it doesn't clash with the celebration
  // ("back on track" + "zero scheduled" merge into one coherent sentence).
  let alsoTitle = insights[1]?.title ?? "";
  if (revived && /^Upcoming: zero/.test(alsoTitle) && alsoTitle.toLowerCase().includes(revived.goal)) {
    streakLine = `${revived.goal[0]!.toUpperCase()}${revived.goal.slice(1)} is back on track after missing a week — though nothing's scheduled for it yet this week.`;
    alsoTitle = insights[2]?.title ?? "";
  }

  // Speak low balances only when something is actually low.
  const low = balance
    .filter((b) => b.score !== null && b.score! < 70)
    .sort((a, b) => a.score! - b.score!)
    .slice(0, 2)
    .map((b) => `${b.domain} at ${b.score}`);
  const balanceLine = low.length ? `Lowest balance: ${low.join(", ")}.` : "Your balance looks strong across the board.";

  const headline = insights[0]?.title ?? "All domains look on track";
  const text = [
    resultsLine,
    `Here's your briefing. ${insights[0] ? hedge(insights[0].confidence, headline) : headline}.`,
    balanceLine,
    alsoTitle ? `Also: ${alsoTitle}.` : "",
    streakLine,
    q ? q.text : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    text,
    data: {
      date: today,
      headline,
      balance,
      insights: insights.map((i) => ({
        id: i.id,
        title: i.title,
        severity: i.severity,
        domains: JSON.parse(i.domains) as string[],
      })),
      question: q ?? null,
      outcomes,
      streaks,
    },
  };
}

/**
 * Proactive nudge — the differentiator. Called by the HOST (our simulated
 * Alexa+; on real Alexa+ this is the add-on-initiated-turns API we're
 * requesting). Speaks first ONLY when the engine found something new;
 * otherwise stays quiet (vision §8: proactive ≠ interrupting).
 */
export function getProactiveNudge(db: DatabaseSync, today: string): ToolResult {
  ensureEngineRun(db, today);
  const fresh =
    (db.prepare("SELECT COUNT(*) AS n FROM insights WHERE status='new'").get() as { n: number }).n +
    (db.prepare("SELECT COUNT(*) AS n FROM questions WHERE status='pending'").get() as { n: number }).n;
  if (fresh === 0) {
    return { text: "", data: { quiet: true, reason: "nothing new needs attention" } };
  }
  const briefing = getDailyBriefing(db, today);
  return {
    text: briefing.text,
    data: { quiet: false, proactive: true, ...briefing.data },
  };
}

// ---------------------------------------------------------------- balance
export function getLifeBalance(db: DatabaseSync, today: string): ToolResult {
  ensureEngineRun(db, today);
  const balance = lifeBalance(loadCtx(db, today));
  const line = (b: DomainScore) =>
    `${b.domain}: ${b.score === null ? "no data yet" : `${b.score} (${b.trend}, ${b.note})`}`;
  return {
    text: `Life balance — ${balance.map(line).join("; ")}.`,
    data: { date: today, balance },
  };
}

// ---------------------------------------------------------------- insight detail
export function getInsight(db: DatabaseSync, insightId: string): ToolResult {
  const row = db.prepare("SELECT * FROM insights WHERE id = ?").get(insightId) as
    | { id: string; title: string; severity: number; domains: string; evidence: string; reasoning: string; confidence: number }
    | undefined;
  if (!row) return { text: `I don't have an insight with id ${insightId}. Ask for your briefing to see current ones.`, data: {}, isError: true };
  const certainty =
    row.confidence < 0.75
      ? "My working read — not yet confirmed: "
      : row.confidence >= 0.85
        ? "I'm confident about this: "
        : "";
  return {
    text: `${row.title}. ${certainty}${row.reasoning} Say "fix it" and I'll propose a plan.`,
    data: {
      id: row.id,
      title: row.title,
      severity: row.severity,
      domains: JSON.parse(row.domains),
      evidence: JSON.parse(row.evidence),
      reasoning: row.reasoning,
      confidence: row.confidence,
    },
  };
}

// ---------------------------------------------------------------- check-in
export function checkIn(
  db: DatabaseSync,
  today: string,
  args: { content: string; domain?: string; question_id?: string; goal_id?: string; amount?: number },
  personId = "alex",
): ToolResult {
  const now = nowAt(today);
  let memoryId: string;
  if (args.question_id) {
    memoryId = recordAnswer(db, personId, args.question_id, args.content, now).memoryId;
  } else {
    memoryId = newId("mem");
    db.prepare(
      `INSERT INTO memory_items (id, person_id, kind, content, confidence, source, question_id, status, created_at, updated_at)
       VALUES (?, ?, 'experience', ?, 0.9, 'user_said', NULL, 'active', ?, ?)`,
    ).run(memoryId, personId, args.content, now, now);
  }

  let pacing: string | null = null;
  if (args.goal_id && typeof args.amount === "number") {
    db.prepare("INSERT INTO goal_logs (id, goal_id, at, value, note) VALUES (?, ?, ?, ?, ?)").run(
      newId("log"), args.goal_id, now, args.amount, args.content,
    );
    const goal = db.prepare("SELECT title FROM goals WHERE id=?").get(args.goal_id) as { title: string } | undefined;
    const target = Number(goal?.title.match(/\$(\d+)/)?.[1] ?? 0);
    const month = today.slice(0, 7);
    const sum = db.prepare("SELECT COALESCE(SUM(value),0) AS s FROM goal_logs WHERE goal_id=? AND at LIKE ?").get(args.goal_id, `${month}%`) as { s: number };
    pacing = target > 0 ? (sum.s >= target ? `on target for ${month}` : `$${target - sum.s} short of the $${target} target for ${month}`) : null;
  }

  // Fresh signal can change insights — refresh the precomputed layer now.
  runEngine(db, today);
  return {
    text: pacing ? `Logged. You're ${pacing}.` : "Got it — I've noted that and updated my understanding.",
    data: { memory_id: memoryId, pacing, engine_refreshed: true },
  };
}

// ---------------------------------------------------------------- remember / review / forget
/** "Actually, I hate morning gym." and "i hate morning gym" are the same memory. */
const normalizeMemory = (s: string) => s.toLowerCase().replace(/^\s*(actually|also|and|so|well|ok(ay)?)[,\s]+/, "").replace(/[^a-z0-9$ ]+/g, " ").replace(/\s+/g, " ").trim();

export function remember(db: DatabaseSync, today: string, content: string, kind: string, personId = "alex"): ToolResult {
  const now = nowAt(today);
  // Saying it twice must not store it twice — dedupe against active memories of the same kind.
  const existing = (
    db.prepare("SELECT id, content FROM memory_items WHERE person_id=? AND kind=? AND status='active'").all(personId, kind) as Array<{ id: string; content: string }>
  ).find((m) => normalizeMemory(m.content) === normalizeMemory(content));
  if (existing) {
    return {
      text: kind === "preference" ? "Already noted — I'm planning around it." : `I already remember that ${kind}.`,
      data: { memory_id: existing.id, kind, content: existing.content, duplicate: true },
    };
  }
  const id = newId("mem");
  db.prepare(
    `INSERT INTO memory_items (id, person_id, kind, content, confidence, source, question_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1.0, 'user_said', NULL, 'active', ?, ?)`,
  ).run(id, personId, kind, content, now, now);
  return {
    text:
      kind === "preference"
        ? "Preference saved — I'll plan around it from now on."
        : `Remembered as a ${kind}.`,
    data: { memory_id: id, kind, content },
  };
}

// Spoken labels per memory kind, in the order they are read out. Only what the
// user said is presented as known; engine inferences are labelled as such.
const MEMORY_LABELS: Array<[kind: string, label: string]> = [
  ["preference", "Preferences"],
  ["fact", "Facts"],
  ["commitment", "Commitments"],
  ["goal_note", "About your goals"],
  ["experience", "Recent check-ins"],
  ["outcome", "Measured outcomes"],
];
const INFERRED_KINDS = new Set(["hypothesis", "pattern"]);
const clean = (s: string) => s.replace(/^\s*(actually|also|and|so|well)[,\s]+/i, "").replace(/[.!]+\s*$/, "").trim();

export function reviewMemory(db: DatabaseSync, filter?: string): ToolResult {
  const rows = (
    db.prepare("SELECT id, kind, content, source, created_at FROM memory_items WHERE status='active' ORDER BY created_at DESC").all() as Array<{
      id: string; kind: string; content: string; source: string; created_at: string;
    }>
  ).filter((m) => !filter || m.content.toLowerCase().includes(filter.toLowerCase()) || m.kind === filter);
  if (rows.length === 0) return { text: "I don't hold any memories matching that.", data: { memories: rows } };

  // 'seed' = onboarding statements by the user; only the engine's own writes count as inferred.
  const isInferred = (m: { kind: string; source: string }) => m.source === "engine_inferred" || INFERRED_KINDS.has(m.kind);
  const said = rows.filter((m) => !isInferred(m));
  const inferred = rows.filter(isInferred);
  const sections: string[] = [];
  for (const [kind, label] of MEMORY_LABELS) {
    const items = said.filter((m) => m.kind === kind);
    if (items.length === 0) continue;
    const shown = items.slice(0, 3).map((m) => clean(m.content));
    sections.push(`${label}: ${shown.join("; ")}${items.length > 3 ? ` (and ${items.length - 3} more)` : ""}.`);
  }
  const text = [
    `Here's what I know about you — ${said.length} ${said.length === 1 ? "thing" : "things"} you've told me${inferred.length ? ` and ${inferred.length} I've inferred but not confirmed` : ""}.`,
    ...sections,
    inferred.length ? `Inferred, unconfirmed: ${inferred.slice(0, 2).map((m) => clean(m.content)).join("; ")}.` : "",
    'Say "forget" plus any item to delete it.',
  ]
    .filter(Boolean)
    .join(" ");
  return { text, data: { memories: rows.map(({ source: _s, ...m }) => m) } };
}

export function forget(db: DatabaseSync, memoryId: string): ToolResult {
  const res = db.prepare("UPDATE memory_items SET status='forgotten' WHERE id=? AND status='active'").run(memoryId);
  if (res.changes === 0) return { text: `I couldn't find an active memory ${memoryId}.`, data: {}, isError: true };
  return { text: "Forgotten. It will no longer inform any analysis.", data: { memory_id: memoryId, status: "forgotten" } };
}

// ---------------------------------------------------------------- goals
export function setGoal(db: DatabaseSync, today: string, args: { title: string; domain: string; cadence_per_week: number }, personId = "alex"): ToolResult {
  const id = newId("goal");
  db.prepare(
    "INSERT INTO goals (id, person_id, domain, title, cadence_per_week, status, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
  ).run(id, personId, args.domain, args.title, args.cadence_per_week, nowAt(today));
  runEngine(db, today);
  return { text: `Goal set: ${args.title}, ${args.cadence_per_week}× per week. I'll start tracking it.`, data: { goal_id: id, ...args } };
}

export function getGoalProgress(db: DatabaseSync, today: string, args: { goal_id?: string; domain?: string }, personId = "alex"): ToolResult {
  const events = db.prepare("SELECT * FROM events WHERE person_id=?").all(personId) as unknown as EventRow[];
  let goals = db.prepare("SELECT * FROM goals WHERE person_id=? AND status='active'").all(personId) as unknown as GoalRow[];
  if (args.goal_id) goals = goals.filter((g) => g.id === args.goal_id);
  if (args.domain) goals = goals.filter((g) => g.domain === args.domain);

  const rows = goals.map((g) => {
    if (g.domain === "finance") {
      const month = today.slice(0, 7);
      const sum = db.prepare("SELECT COALESCE(SUM(value),0) AS s FROM goal_logs WHERE goal_id=? AND at LIKE ?").get(g.id, `${month}%`) as { s: number };
      return { goal_id: g.id, title: g.title, domain: g.domain, actual: sum.s, target: Number(g.title.match(/\$(\d+)/)?.[1] ?? 0), unit: "$ this month", streak_weeks: 0 };
    }
    const actual = goalActual(events, g, addDays(today, -7), today);
    let streak = 0;
    for (let k = 1; k <= 8; k++) {
      if (goalActual(events, g, addDays(today, -7 * k), addDays(today, -7 * (k - 1))) >= g.cadence_per_week) streak++;
      else break;
    }
    return { goal_id: g.id, title: g.title, domain: g.domain, actual, target: g.cadence_per_week, unit: "last week", streak_weeks: streak };
  });

  if (rows.length === 0) return { text: "No matching goals.", data: { goals: [] } };
  const line = (r: (typeof rows)[number]) =>
    r.domain === "finance"
      ? `house fund $${r.actual} of $${r.target} this month`
      : `${keywordOf(r.title)} ${r.actual} of ${r.target}`;
  const behind = rows.filter((r) => r.actual < r.target);
  const text =
    behind.length === 0
      ? `You hit everything: ${rows.map(line).join(", ")}. Strong week.`
      : `Behind on ${behind.map(line).join(" and ")}; on track with ${rows.filter((r) => r.actual >= r.target).map(line).join(", ") || "nothing else yet"}.`;
  return { text, data: { goals: rows } };
}

// ---------------------------------------------------------------- plans
export function proposePlanTool(db: DatabaseSync, today: string, insightId: string): ToolResult {
  const plan = proposePlan(db, insightId, today);
  if (plan.changes.length === 0) {
    return { text: "I couldn't find safe changes for that — your locked schedule leaves no room this week.", data: { plan_id: plan.id, changes: [] } };
  }
  const human = plan.changes.map((c: Change) =>
    c.op === "create" ? `add "${c.title}" ${when(c.start!)}` : `move "${c.title}" to ${when(c.to!.start)}`,
  );
  return {
    text: `Here's the plan: ${human.join("; ")}. Trade-offs: ${plan.tradeoffs}${
      plan.hypothesis ? ` This is an experiment — my hypothesis: ${plan.hypothesis} I'll measure it next week.` : ""
    } Shall I apply it?`,
    data: {
      plan_id: plan.id, title: plan.title, changes: plan.changes, tradeoffs: plan.tradeoffs,
      expected_benefit: plan.expectedBenefit, hypothesis: plan.hypothesis, requires_approval: true,
    },
  };
}

export function applyPlanTool(db: DatabaseSync, today: string, planId: string, approve: boolean): ToolResult {
  if (approve !== true) {
    const plan = db.prepare("SELECT title FROM plans WHERE id=?").get(planId) as { title: string } | undefined;
    return {
      text: plan ? `To confirm: apply "${plan.title}"? Say yes to proceed.` : `I don't know plan ${planId}.`,
      data: { plan_id: planId, requires_approval: true },
      isError: !plan,
    };
  }
  try {
    const res = applyPlan(db, planId, nowAt(today));
    runEngine(db, today); // refresh insights with the new calendar state
    const ok = res.executed.filter((e) => e.ok).length;
    if (!res.allVerified) {
      const failed = res.executed.filter((e) => !e.ok).map((e) => `${e.title}: ${e.detail}`);
      return { text: `I applied ${ok} of ${res.executed.length} changes but could not verify: ${failed.join("; ")}. Nothing else was touched.`, data: { ...res }, isError: true };
    }
    return { text: `Done and verified — all ${ok} changes are on the calendar. I'll check how the week went and report back.`, data: { ...res } };
  } catch (e) {
    return { text: `I couldn't apply that plan: ${(e as Error).message}`, data: { plan_id: planId }, isError: true };
  }
}

// ---------------------------------------------------------------- what-if simulation
/**
 * Think AHEAD of the user: preview the cost of a decision before it's made.
 * Inserts a hypothetical event, re-runs every detector on the alternate week,
 * and reports exactly what would break — pure functions make this instant.
 */
export function simulateChange(
  db: DatabaseSync,
  today: string,
  args: { title: string; day: string; start_time: string; duration_minutes?: number; domain?: string },
): ToolResult {
  const ctx = loadCtx(db, today);
  const wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].indexOf(
    args.day.trim().toLowerCase(),
  );
  const date = /^\d{4}-\d{2}-\d{2}$/.test(args.day) ? args.day : wd >= 0 ? addDays(today, wd) : null;
  if (!date) {
    return { text: `Which day do you mean? Say a weekday like "Thursday" or a date.`, data: {}, isError: true };
  }
  const start = `${date}T${args.start_time.padStart(5, "0")}:00`;
  const end = fromMs(toMs(start) + (args.duration_minutes ?? 120) * 60_000);
  const hypothetical = {
    id: "evt_hypothetical",
    person_id: "alex",
    title: args.title,
    start,
    end,
    domain: (args.domain ?? "work") as "work",
    flexible: 0,
    source: "seed" as const,
    reschedule_count: 0,
  };

  const base = runDetectors(ctx);
  const alt = runDetectors({ ...ctx, events: [...ctx.events, hypothetical] });
  const newRisks = alt.filter((f) => !base.some((b) => b.title === f.title)).map((f) => f.title);
  const conflicts = ctx.events
    .filter((e) => e.start.slice(0, 10) === date && overlaps(start, end, e.start, e.end))
    .map((e) => ({ title: e.title, start: e.start, domain: e.domain }));

  const safe = conflicts.length === 0 && newRisks.length === 0;
  const text = safe
    ? `I checked the week: "${args.title}" on ${args.day} at ${args.start_time} fits — no conflicts, and none of your goals lose their slot.`
    : `If you take "${args.title}" ${args.day} at ${args.start_time}: ${[
        ...conflicts.map((c) => `it collides with ${c.title} at ${c.start.slice(11, 16)}`),
        ...newRisks.map((r) => r.toLowerCase()),
      ].join("; ")}. I'd look for a different slot — want me to find one?`;

  return {
    text,
    data: { hypothetical: { title: args.title, start, end }, conflicts, new_risks: newRisks, recommendation: safe ? "safe" : "reschedule" },
  };
}

// ---------------------------------------------------------------- what changed
export function whatsChanged(db: DatabaseSync, today: string, since?: string): ToolResult {
  const from = since ?? addDays(today, -7);
  // Measure anything whose follow-up window has completed by "today".
  runEngine(db, today);
  const outcomes = db
    .prepare(
      `SELECT o.metric, o.baseline, o.observed, o.verdict, p.title, p.hypothesis FROM outcomes o JOIN plans p ON p.id=o.plan_id WHERE o.measured_at >= ?`,
    )
    .all(from) as Array<{ metric: string; baseline: number; observed: number; verdict: string; title: string; hypothesis: string | null }>;
  const hypothesis = outcomes.find((o) => o.hypothesis)?.hypothesis ?? null;
  const confirmed = outcomes.length > 0 && outcomes.every((o) => o.verdict === "improved");
  const text =
    outcomes.length === 0
      ? "No measured outcomes yet — results land a week after a plan is applied."
      : `Results: ${outcomes.map((o) => `${o.metric.replace("_adherence", "")} went ${o.baseline} to ${o.observed} (${o.verdict})`).join("; ")}.${
          hypothesis ? ` ${confirmed ? "Hypothesis confirmed" : "Hypothesis partly held"}: ${hypothesis}` : ""
        }`;
  return { text, data: { since: from, outcomes, hypothesis, hypothesis_confirmed: confirmed } };
}
