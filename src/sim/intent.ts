/**
 * Intent classification for the deterministic rules brain — and the same
 * labels the evaluation suite scores against. Pure function of the text and
 * the session state; no LLM. Each intent maps to ONE kind of action, so that
 * "check_in for everything" and "same canned line for everything" cannot happen.
 */
import type { SessionState } from "./orchestrator.js";
import { parsePreference } from "../engine/preferences.js";

export type Intent =
  | "approve_plan" | "reject_plan" | "accept_offer" | "decline_offer"
  | "greeting" | "thanks" | "goodbye" | "nevermind" | "help"
  | "support" | "meta_complaint"
  | "know_query" | "want_question" | "agent_question"
  | "preference" | "correction" | "fact" | "goal_note" | "goal_update"
  | "completion" | "savings_progress"
  | "whatif" | "direct_edit" | "forget_text" | "advice"
  | "route" // a named tool route (briefing, balance, goals, results, insight, plan, memory review, forget id)
  | "question_answer" | "ambiguous_answer" | "statement" | "stray_yes" | "stray_no" | "off_topic_question" | "unclear";

export interface Classified {
  intent: Intent;
  /** Extracted payload, intent-specific. */
  payload: Record<string, unknown>;
}

// A decision is the WHOLE message ("Yes, do it." / "Not now") — "No gym in the
// mornings" or "Yes I hate mornings" are statements, not decisions.
export const YES = /^(?:(?:yes|yeah|yep|sure|ok(?:ay)?)(?:[,!.]?\s*(?:please|do it|apply(?: it)?|go ahead|confirm|let'?s do it))?|do it|apply(?: it)?|go ahead|confirm|please do)[!. ]*$/i;
export const NO = /^(?:no|nope|not now|no thanks|leave it|skip(?: it)?|later|maybe later|don'?t(?: do it| apply it)?|not yet)[!. ]*$/i;
const SMALLTALK_GREET = /^(hi|hello|hey|yo|hiya)\b[!. ]*$/i;
const THANKS = /^(thanks?( you)?( a lot)?|thank you|cheers)\b/i;
const BYE = /^(bye|good ?night|see you)\b/i;
const NEVERMIND = /^(never ?mind|forget it|drop it)\b/i;
const FEELING = /\b(i'?m|i am|i feel|feeling|been)\s+(so |really |completely |totally |a bit |kind of |very )?(exhausted|tired|drained|burnt out|burned out|stressed|overwhelmed|anxious|sad|miserable|depressed|lonely|failing|hopeless|lost|guilty)\b/i;
const META = /\b(you (already )?asked( me)? (that|this)|asked me that already|you keep asking|again\?|stop asking)\b/i;
const COMPLETION = /\b(went to|did|had|made it to|skipped|missed|cancel+ed)\b(?: the| my| our)?\s+(gym|date night|spanish|call mom|workout)\b(?:.*\b(once|twice|\d+ times|three times))?/i;
const WHATIF = /^(?:what (?:happens |would happen )?if i|can i|could i|should i|is it ok(?:ay)? (?:if i|to)|would it be ok(?:ay)? to)\s+(?:take|accept|add|schedule|move|put|book|do|have|go to|fit(?: in)?)\s+(?:an? |the |my )?(.+?)(?: on| to)? (monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?: at (\d{1,2})(?::(\d{2}))?\s*(pm|am)?)?\??$/i;
const CORRECTION = /\b(?:not\s+[A-Z][a-z]+|i meant|that'?s wrong|correction|actually (?:my|his|her|it'?s|it is))\b/;
const FACT = /^(?:my|our)\s+[\w' ]+\s+(?:is|are|was)\s+|\b(?:[A-Z][a-z]+|my (?:wife|husband|partner|son|daughter|mom|dad|boss))\s+(?:has|have|goes to|works|is at)\s+[\w ]+\s+(?:on|every|at)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekday|weekend)s?\b|\bi work from home\b|\bmy (?:wife|husband|partner)'?s name is\b/i;
const GOAL_UPDATE = /\b(?:(?:change|set|make|update)\s+(?:my\s+)?(\w[\w ]*?)\s+(?:goal\s+)?to\s+(\d+)\s*(?:times?|x)?(?:\s*(?:a|per)\s*week)?|(\d+)\s*(?:times?|x)\s*(?:a|per)\s*week\s+(?:is|would be|from now on)|(?:i want|i'?d like)\s+to\s+(?:go to the |do )?(\w[\w ]*?)\s+(\d+)\s*(?:times?|x)\s*(?:a|per)\s*week)\b/i;
const GOAL_NOTE = /^(i (really |just )?(want|need|wish|would like|would love)|i'?d (like|love)|my goal is)\b/i;
const ADVICE = /\b(what should i do|should i\b|any advice|what do you (think|suggest|recommend)|how (do|can|should) i\b)/i;
const KNOW = /what do you know about me|show (your |my )?memor|what have you (got|stored)/i;
const WANT_Q = /what (do|would) you (want|like) to know|ask me (something|anything)|(any|got) questions? for me/i;
const AGENT_Q = /\b(can|could|do|are|will|would) you (listen|hear)\b|\b(who|what) are you\b|^(hey|hi|hello|ok|okay|so)?[,\s]*(can|could|do|are|will|would|what|who|how|why|where|when) you\b/i;
const DIRECT_EDIT = /^(move|reschedule|cancel|shift|put|book|schedule)\b/i;
const FORGET_TEXT = /^forget (?:that |the |about )?(.+?)(?: thing| memory| one)?[.!?]*$/i;
const SAVINGS = /(?:put in|put|saved|deposited|transferred|added)\s*\$?(\d+)|\$?(\d+) (in|into|to|toward) the/i;
const ROUTES: Array<[RegExp, string]> = [
  [/\b(my )?goals?\b|\bstreaks?\b|goal progress|how am i doing on/i, "get_goal_progress"],
  [/briefing|good morning|catch me up|how('s| is) my (week|day)|how am i doing( this week| today)?\??$|^what('s| is) (up|new)/i, "get_daily_briefing"],
  [/\b(life |my )balance\b|how('s| is) my life|am i balanced|how am i (doing )?overall|^overall\??$/i, "get_life_balance"],
  [/did it work|how did (my|the) week go|what('s| has) changed|\bresults\b/i, "whats_changed"],
  [/^remember (that )?(.+)/i, "remember"],
  [/^forget ([a-z]+_[a-z0-9]+)/i, "forget"],
  [/^(tell me more|why|explain|show me the evidence|what('s| is) the evidence)\b/i, "get_insight"],
  [/\b(fix (it|this|that|my (week|schedule))|make (me )?a plan|plan (it|my week)|suggest (something|changes|a plan)|help me change|sort (it|this) out)\b/i, "propose_plan"],
];

export function classifyIntent(raw: string, state: SessionState): Classified {
  const text = raw.trim();
  const t = text.toLowerCase();
  const words = text.split(/\s+/).length;

  // Decisions on pending things come first: a bare "yes" means the pending thing.
  if (state.planAwaitingApproval && YES.test(text)) return { intent: "approve_plan", payload: {} };
  if (state.planAwaitingApproval && NO.test(text)) return { intent: "reject_plan", payload: {} };
  if (state.pendingOffer && (YES.test(text) || /^(find one|go on)\b/i.test(text))) return { intent: "accept_offer", payload: {} };
  if (state.pendingOffer && NO.test(text)) return { intent: "decline_offer", payload: {} };

  if (SMALLTALK_GREET.test(text)) return { intent: "greeting", payload: {} };
  // A bare yes/no (nothing else in the sentence) with nothing pending.
  // (If the open question is a yes/no one — "did X happen?" — a bare yes/no is its answer instead.)
  const yesNoQuestionOpen = !!state.lastQuestionId && /\b(happen|how many|did you|have you)\b/i.test(state.lastQuestionText ?? "");
  if (YES.test(text) && !yesNoQuestionOpen) return { intent: "stray_yes", payload: {} };
  if (NO.test(text) && !yesNoQuestionOpen) return { intent: "stray_no", payload: {} };
  if (THANKS.test(text) && words <= 4) return { intent: "thanks", payload: {} };
  if (BYE.test(text) && words <= 3) return { intent: "goodbye", payload: {} };
  if (NEVERMIND.test(text)) return { intent: "nevermind", payload: {} };
  if (/^(help|what can you do)\b/i.test(text)) return { intent: "help", payload: {} };
  if (META.test(text)) return { intent: "meta_complaint", payload: {} };
  if (KNOW.test(t)) return { intent: "know_query", payload: {} };
  if (WANT_Q.test(t)) return { intent: "want_question", payload: {} };
  if (AGENT_Q.test(text) && !ADVICE.test(text)) return { intent: "agent_question", payload: { listen: /\b(listen|hear)\b/i.test(text), who: /\b(who|what) are you\b/i.test(text) } };

  const whatif = text.match(WHATIF);
  if (whatif) {
    let h = whatif[3] ? Number(whatif[3]) : 19;
    const ap = whatif[5]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    return { intent: "whatif", payload: { title: whatif[1], day: whatif[2], start_time: `${String(h).padStart(2, "0")}:${whatif[4] ?? "00"}` } };
  }
  const savings = text.match(SAVINGS);
  if (savings) return { intent: "savings_progress", payload: { amount: Number(savings[1] ?? savings[2]) } };
  const forget = text.match(FORGET_TEXT);
  if (forget && !/^[a-z]+_[a-z0-9]+$/i.test(forget[1]!)) return { intent: "forget_text", payload: { filter: forget[1] } };

  const completion = text.match(COMPLETION);
  if (completion) {
    const c = completion[3]?.toLowerCase();
    const count = c === "twice" ? 2 : c === "three times" ? 3 : c?.match(/^(\d+)/) ? Number(c.match(/^(\d+)/)![1]) : 1;
    const day = text.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i)?.[1];
    return { intent: "completion", payload: { title: completion[2], status: /skip|miss|cancel/i.test(completion[1]!) ? "missed" : "done", count, day } };
  }

  // Durable knowledge: preference > goal update > correction > fact > goal note.
  const pref = parsePreference(text);
  if (pref && !FEELING.test(text)) return { intent: "preference", payload: { parsed: pref } };
  const gu = text.match(GOAL_UPDATE);
  if (gu) return { intent: "goal_update", payload: { subject: (gu[1] ?? gu[4] ?? "").trim(), cadence: Number(gu[2] ?? gu[3] ?? gu[5]) } };
  if (CORRECTION.test(text) && !state.lastQuestionId) return { intent: "correction", payload: {} };
  if (FACT.test(text) && !/\?\s*$/.test(text)) return { intent: "fact", payload: {} };
  if (GOAL_NOTE.test(text)) return { intent: "goal_note", payload: {} };
  if (DIRECT_EDIT.test(text)) return { intent: "direct_edit", payload: {} };
  if (FEELING.test(text)) return { intent: "support", payload: { clause: text.replace(/[.!]+$/, "") } };
  if (ADVICE.test(text)) return { intent: "advice", payload: {} };

  for (const [re, tool] of ROUTES) {
    const m = text.match(re);
    if (m) {
      // A sentence-length answer to the open question must not trip a route word.
      const commandShaped = /^(what|how|why|tell|show|fix|give|can|could|did|do|is|are|remember|forget|help)\b/i.test(text);
      if (state.lastQuestionId && words >= 6 && !commandShaped) break;
      return { intent: "route", payload: { tool, match: m } };
    }
  }

  // A question the user asks ("What's the capital of France?") is never the answer
  // to Align's question — and Align only knows the user's own data.
  if (/^(what|who|when|where|how|why|which|is|are|do|does|can|could|should|will)\b/i.test(text) && /\?\s*$/.test(text) && !/\b(you|your)\b/i.test(text)) {
    return { intent: "off_topic_question", payload: {} };
  }
  if (state.lastQuestionId) {
    // Short hedges are not answers; anything else is the answer.
    // Only a completion question ("did X happen?", "how many…?") has a yes/no/number answer; a hedge there is not evidence.
    const completionQuestion = /\b(happen|how many)\b/i.test(state.lastQuestionText ?? "");
    if (completionQuestion && /\b(i think|maybe|not sure|i don'?t (really )?know|dunno|i guess|or so|probably|can'?t remember)\b|^(hmm|it was (a )?(weird|strange|odd) week)\b/i.test(text)) return { intent: "ambiguous_answer", payload: {} };
    return { intent: "question_answer", payload: {} };
  }
  if (/\?\s*$/.test(text)) return { intent: "unclear", payload: {} };
  return { intent: "statement", payload: {} };
}
