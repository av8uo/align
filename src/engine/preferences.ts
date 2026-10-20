/**
 * Structured preferences. A spoken preference ("I hate morning workouts",
 * "mornings work better for me now") is parsed ONCE into subject × time ×
 * polarity, so that:
 *  - the planner honors it regardless of wording (workout = gym = exercise),
 *  - a paraphrase is recognised as a duplicate, not stored again,
 *  - a later statement about the same subject supersedes the earlier one.
 * Deterministic, no LLM: what it can't parse, it leaves as plain text.
 */
import type { GoalRow } from "../core/types.js";
import { keywordOf } from "./detectors.js";

export type TimeOfDay = "morning" | "evening";
export interface ParsedPreference {
  /** A goal keyword ("gym"), a domain ("health"), or null = general (applies to everything). */
  subject: { kind: "goal"; keyword: string } | { kind: "domain"; domain: string } | null;
  time: TimeOfDay | null;
  polarity: "like" | "dislike";
}

const SUBJECTS: Array<[RegExp, ParsedPreference["subject"]]> = [
  [/\b(gym|work ?outs?|exercis\w*|training|run(?:ning)?)\b/, { kind: "goal", keyword: "gym" }],
  [/\b(spanish|language|study(?:ing)?|learn(?:ing)?)\b/, { kind: "goal", keyword: "spanish practice" }],
  [/\b(date nights?|dates? with|time with (?:my )?(?:wife|husband|partner))\b/, { kind: "goal", keyword: "date night" }],
  [/\b(call(?:ing)? (?:my )?mom|mom)\b/, { kind: "goal", keyword: "call mom" }],
  [/\b(family time|the kids|my kids)\b/, { kind: "domain", domain: "family" }],
  [/\b(deep work|meetings?|focus(?:ed)? work)\b/, { kind: "domain", domain: "work" }],
];
// Verb forms included ("hates", "prefers"): an LLM host may store the preference in the third person.
const DISLIKE = /\b(hates?|dislikes?|don'?t like|doesn'?t like|can'?t stand|not a fan|avoids?|no more|never again|don'?t work(?:s)? for me|doesn'?t work|not (?:in|on) the (?:mornings?|evenings?|nights?))\b|^no\s+\w[\w ]*\s+(?:in|on) the (?:mornings?|evenings?|nights?)\b/;
const LIKE = /\b(loves?|likes?|prefers?|rather|better|best|works? (?:well|better|best) for (?:me|them|the user)|great for (?:me|them)|ideal|enjoys?)\b/;

export function parsePreference(content: string): ParsedPreference | null {
  const c = content.toLowerCase();
  const time: TimeOfDay | null = /\bmornings?\b|\bearly\b|\bbefore work\b/.test(c) ? "morning" : /\bevenings?\b|\bnights?\b|\bafter work\b/.test(c) ? "evening" : null;
  const dislike = DISLIKE.test(c);
  const like = LIKE.test(c);
  if (!time || (!dislike && !like)) return null;
  // "I hate morning workouts" → dislike:morning. "Mornings work better now" → like:morning.
  // "Evenings don't work for me" → dislike:evening.
  const polarity: ParsedPreference["polarity"] = dislike && !/\b(better|best|prefer|rather)\b/.test(c) ? "dislike" : "like";
  let subject: ParsedPreference["subject"] = null;
  for (const [re, s] of SUBJECTS) if (re.test(c)) { subject = s; break; }
  return { subject, time, polarity };
}

/** The time of day a preference argues FOR: liking mornings or disliking evenings both mean morning. */
export const impliedTime = (p: ParsedPreference): TimeOfDay => (p.polarity === "like" ? p.time! : p.time === "morning" ? "evening" : "morning");

function subjectCovers(a: ParsedPreference["subject"], goal: GoalRow): boolean {
  if (a === null) return true;
  if (a.kind === "domain") return a.domain === goal.domain;
  return keywordOf(goal.title) === a.keyword || goal.title.toLowerCase().includes(a.keyword);
}

const specificity = (s: ParsedPreference["subject"]): number => (s === null ? 0 : s.kind === "domain" ? 1 : 2);

/**
 * Relationship between a new preference and an existing one:
 *  - duplicate: same subject, same implied time (paraphrases)
 *  - supersedes: same or broader subject, different implied time (a change of mind)
 *  - refines: narrower subject, different implied time (an exception: both stay active)
 *  - unrelated: different subjects
 */
export function relatePreferences(next: ParsedPreference, prev: ParsedPreference): "duplicate" | "supersedes" | "refines" | "unrelated" {
  const sameSubject = JSON.stringify(next.subject) === JSON.stringify(prev.subject);
  const overlapping =
    sameSubject ||
    next.subject === null ||
    prev.subject === null ||
    (next.subject.kind === "domain" && prev.subject.kind === "goal" && goalDomain(prev.subject.keyword) === next.subject.domain) ||
    (prev.subject.kind === "domain" && next.subject.kind === "goal" && goalDomain(next.subject.keyword) === prev.subject.domain);
  if (!overlapping) return "unrelated";
  if (impliedTime(next) === impliedTime(prev)) return sameSubject ? "duplicate" : specificity(next.subject) >= specificity(prev.subject) ? "duplicate" : "unrelated";
  // Different time: a statement at least as general as the old one is a change of
  // mind (supersedes); a more specific one is an exception to it (refines — keep both).
  return specificity(next.subject) <= specificity(prev.subject) ? "supersedes" : "refines";
}

const goalDomain = (keyword: string): string =>
  keyword === "gym" ? "health" : keyword === "spanish practice" ? "personal" : keyword === "date night" || keyword === "call mom" ? "family" : "personal";

/**
 * The time of day the planner should use for a goal, from the ACTIVE
 * preferences — most specific subject wins, then the most recent statement.
 */
export function preferredTimeFor(
  goal: GoalRow,
  memories: Array<{ kind: string; content: string; status: string; created_at?: string }>,
): TimeOfDay | null {
  let best: { time: TimeOfDay; spec: number; at: string } | null = null;
  for (const m of memories) {
    if (m.kind !== "preference" || m.status !== "active") continue;
    const p = parsePreference(m.content);
    if (!p || !subjectCovers(p.subject, goal)) continue;
    const cand = { time: impliedTime(p), spec: specificity(p.subject), at: m.created_at ?? "" };
    if (!best || cand.spec > best.spec || (cand.spec === best.spec && cand.at > best.at)) best = cand;
  }
  return best?.time ?? null;
}
