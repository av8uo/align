/**
 * The conversational context layer: what the host (LLM or rules) should know
 * BEFORE answering a turn. Durable knowledge comes from the database; temporary
 * conversational state from the session. Only what is relevant to this turn is
 * included — never a dump of every memory — and every item is attributable.
 */
import type { DatabaseSync } from "node:sqlite";
import type { SessionState } from "./orchestrator.js";
import { parsePreference, impliedTime } from "../engine/preferences.js";
import { goalActual } from "../engine/detectors.js";
import { lifeBalance } from "../engine/balance.js";
import { whatWouldHelp } from "../engine/advice.js";
import { loadCtx } from "../engine/engine.js";
import type { EventRow, GoalRow } from "../core/types.js";
import { addDays } from "../engine/time.js";

export interface TurnContext {
  facts: Array<{ id: string; content: string }>;
  preferences: Array<{ id: string; content: string; time: string | null; subject: string }>;
  superseded: Array<{ old: string; by: string }>;
  goals: Array<{ id: string; title: string; target: number; lastWeek: number; domain: string }>;
  commitments: string[];
  openQuestion: { id: string; text: string; decides: string | null; askedAt: string | null } | null;
  recentQuestions: Array<{ text: string; status: string; when: string | null }>;
  hypotheses: Array<{ title: string; confidence: number; status: string }>;
  pendingPlan: { id: string; awaiting: boolean } | null;
  recentPlans: Array<{ id: string; status: string }>;
  recentTopics: string[];
  offeredPlan: boolean;
  /** Engine-derived next steps for the weakest areas (grounded; the host leads with these). */
  nextSteps: Array<{ domain: string; line: string; basis: string }>;
  text: string;
}

const STOP = new Set(["the", "a", "an", "and", "or", "i", "my", "me", "to", "of", "in", "on", "it", "is", "for", "with", "that", "this", "you", "we", "at", "be", "so", "but", "not", "was", "are", "have", "has", "do"]);
const keywords = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

export function buildContext(db: DatabaseSync, state: SessionState, text: string, today: string, personId = "alex"): TurnContext {
  const mem = db
    .prepare("SELECT id, kind, content, status, source, supersedes_id, created_at FROM memory_items WHERE person_id=? AND status IN ('active','corrected') ORDER BY created_at DESC")
    .all(personId) as Array<{ id: string; kind: string; content: string; status: string; source: string; supersedes_id: string | null; created_at: string }>;
  const active = mem.filter((m) => m.status === "active");
  const kw = new Set(keywords(text));
  const relevant = (c: string) => keywords(c).some((w) => kw.has(w));

  // Facts: all when few; otherwise the ones that share a keyword with this turn, plus the newest.
  const allFacts = active.filter((m) => m.kind === "fact").map((m) => ({ id: m.id, content: m.content }));
  const facts = allFacts.length <= 8 ? allFacts : [...allFacts.filter((f) => relevant(f.content)), ...allFacts.slice(0, 3)].filter((f, i, a) => a.findIndex((x) => x.id === f.id) === i).slice(0, 8);

  const preferences = active
    .filter((m) => m.kind === "preference")
    .map((m) => {
      const p = parsePreference(m.content);
      return { id: m.id, content: m.content, time: p ? impliedTime(p) : null, subject: p?.subject ? (p.subject.kind === "goal" ? p.subject.keyword : p.subject.domain) : p ? "everything" : "—" };
    })
    .slice(0, 8);

  const superseded = active
    .filter((m) => m.supersedes_id)
    .map((m) => ({ old: mem.find((o) => o.id === m.supersedes_id)?.content ?? "?", by: m.content }))
    .slice(0, 3);

  const events = db.prepare("SELECT * FROM events WHERE person_id=?").all(personId) as unknown as EventRow[];
  const goals = (db.prepare("SELECT * FROM goals WHERE person_id=? AND status='active'").all(personId) as unknown as GoalRow[]).map((g) => ({
    id: g.id, title: g.title, domain: g.domain, target: g.cadence_per_week, lastWeek: g.domain === "finance" ? 0 : goalActual(events, g, addDays(today, -7), today),
  }));
  const commitments = active.filter((m) => m.kind === "commitment" || m.kind === "goal_note").map((m) => m.content).slice(0, 5);

  const q = state.lastQuestionId
    ? (db.prepare("SELECT q.id, q.text, q.asked_at, g.decision_ref FROM questions q LEFT JOIN knowledge_gaps g ON g.id=q.gap_id WHERE q.id=?").get(state.lastQuestionId) as { id: string; text: string; asked_at: string | null; decision_ref: string | null } | undefined)
    : undefined;
  const openQuestion = q ? { id: q.id, text: q.text, decides: q.decision_ref, askedAt: q.asked_at } : null;
  const recentQuestions = (db
    .prepare("SELECT text, status, asked_at FROM questions WHERE asked_at >= ? OR status='pending' ORDER BY asked_at DESC LIMIT 5")
    .all(`${addDays(today, -14)}T00:00:00`) as Array<{ text: string; status: string; asked_at: string | null }>).map((r) => ({ text: r.text, status: r.status, when: r.asked_at }));

  const hypotheses = (db.prepare("SELECT title, confidence, status FROM insights WHERE status IN ('new','surfaced') ORDER BY severity DESC LIMIT 3").all() as Array<{ title: string; confidence: number; status: string }>);
  const pendingPlan = state.lastPlanId ? { id: state.lastPlanId, awaiting: state.planAwaitingApproval } : null;
  const recentPlans = (db.prepare("SELECT id, status FROM plans ORDER BY rowid DESC LIMIT 3").all() as Array<{ id: string; status: string }>);
  const recentTopics = state.history.filter((h) => h.role === "user").slice(-3).map((h) => h.text.slice(0, 80));
  const offeredPlan = state.history.some((h) => h.role === "assistant" && /\b(fix it|a plan|put together a plan|draft a plan)\b/i.test(h.text));
  let nextSteps: TurnContext["nextSteps"] = [];
  try {
    nextSteps = whatWouldHelp(db, today, lifeBalance(loadCtx(db, today, personId)), 2, personId).map((h) => ({ domain: h.domain, line: h.line, basis: h.basis }));
  } catch { /* advice is optional context */ }
  return { facts, preferences, superseded, goals, commitments, openQuestion, recentQuestions, hypotheses, pendingPlan, recentPlans, recentTopics, offeredPlan, nextSteps, text };
}

/**
 * Instruction for the proactive turn: the host may rephrase and shorten the
 * briefing, but every engine-supplied "What would help" step is listed and must
 * be kept with its evidence, and no advice may be added.
 */
export function proactiveInstruction(computedText: string, help: Array<{ line: string }> = []): string {
  const steps = help.length
    ? `\n\nNext steps the engine derived from evidence (use ONLY these; never add advice of your own):\n${help.map((h) => `- ${h.line}`).join("\n")}`
    : "";
  return (
    `(Proactive turn — you speak first, unprompted, like a coach who has been watching the week: short and specific, not a report. ` +
    `Open with the ONE next step that matters most to the user's top-ranked value (family first if it is there) — what and why, in one breath, with its numbers. ` +
    `Then at most one other item from the briefing, in a few words. If there is a question at the end of the briefing, ask it last, lightly, in natural words that keep its exact meaning (same person, same topic) — never press for an answer or mention that it went unanswered before. ` +
    `Do NOT open with the headline sentence verbatim, do NOT list every number, do NOT say "Here's your briefing", do NOT call tools. If a plan is on offer, mention it in five words. 2–3 spoken sentences total; the user can ask for the rest.)` +
    steps +
    `\n\nBriefing (full computed content, for reference):\n${computedText}`
  );
}

/** Compact, attributable rendering for the host model (a few hundred tokens, not a memory dump). */
export function renderContext(c: TurnContext): string {
  const lines: string[] = ["CONTEXT (from Align's records — cite, don't re-save, don't re-ask):"];
  if (!c.facts.length && !c.goals.length && !c.preferences.length) {
    lines.push("NEW USER: no goals, facts or preferences recorded yet — run the onboarding interview per your rules.");
  }
  if (c.facts.length) lines.push(`Facts the user stated: ${c.facts.map((f) => f.content.replace(/[.!]+$/, "")).join("; ")}.`);
  if (c.preferences.length) lines.push(`Active preferences: ${c.preferences.map((p) => `"${p.content.replace(/[.!]+$/, "")}"${p.time ? ` → ${p.subject}: ${p.time}` : ""}`).join("; ")}.`);
  if (c.superseded.length) lines.push(`Superseded (older belief → current): ${c.superseded.map((s) => `"${s.old}" → "${s.by}"`).join("; ")}.`);
  if (c.goals.length) lines.push(`Goals (last week): ${c.goals.map((g) => `${g.title} ${g.domain === "finance" ? "" : `${g.lastWeek}/${g.target}`}`.trim()).join("; ")}.`);
  if (c.commitments.length) lines.push(`Commitments / wants: ${c.commitments.join("; ")}.`);
  if (c.nextSteps.length) lines.push(`Best next steps right now (engine-derived, evidence-based — lead with these when the user talks about their life): ${c.nextSteps.map((n) => `${n.line} [${n.basis}]`).join(" | ")}`);
  if (c.hypotheses.length) lines.push(`Current insights: ${c.hypotheses.map((h) => `${h.title} (confidence ${h.confidence.toFixed(2)}${h.confidence < 0.75 ? ", still a working read" : ""})`).join("; ")}.`);
  if (c.openQuestion) lines.push(`Open question you already asked (don't repeat it verbatim; if the user answers, pass question_id=${c.openQuestion.id} to check_in): "${c.openQuestion.text}"${c.openQuestion.decides ? ` — it decides ${c.openQuestion.decides}` : ""}.`);
  else lines.push("No open question. Do not invent one; at most one focused follow-up if it would change what you do.");
  const asked = c.recentQuestions.filter((r) => r.status !== "pending");
  if (asked.length) lines.push(`Questions already asked recently (don't ask again): ${asked.map((r) => `"${r.text}" (${r.status})`).join("; ")}.`);
  if (c.pendingPlan) lines.push(c.pendingPlan.awaiting ? `A plan (${c.pendingPlan.id}) is awaiting the user's yes/no.` : `The last plan (${c.pendingPlan.id}) was decided; don't re-offer it unless asked.`);
  if (c.offeredPlan && !c.pendingPlan?.awaiting) lines.push("You already offered to make a plan this session — don't offer again unless the user asks.");
  if (c.recentTopics.length) lines.push(`Recent user turns: ${c.recentTopics.map((t) => `"${t}"`).join(" | ")}.`);
  return lines.join("\n");
}
