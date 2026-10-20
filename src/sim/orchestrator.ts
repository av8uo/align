/**
 * The simulated Alexa+ orchestrator: turns a spoken/typed utterance into MCP
 * tool calls and a spoken reply — exactly the role Alexa+ plays in production.
 *
 * Two brains, same tool wire:
 *  - "bedrock": Claude on AWS Bedrock decides which MCP tools to call (AWS Builder path)
 *  - "rules":   a deterministic fallback router, so the demo never depends on cloud access
 */
export interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  text: string;
  data: Record<string, unknown> | undefined;
  isError: boolean;
}

export interface OrchestratorReply {
  reply: string;
  toolCalls: ToolCallRecord[];
  brain: "bedrock" | "rules";
}

export interface SessionState {
  lastQuestionId: string | null;
  /** Spoken text of the last question Align asked, so it can be repeated on request. */
  lastQuestionText: string | null;
  /** Content key of the last briefing delivered in this session (proactively or on request) — never read twice verbatim. */
  lastBriefingKey: string | null;
  /** An offer Align made that a bare "yes" can accept (e.g. "want me to find a different slot?"). */
  pendingOffer: { kind: "find_slot"; title: string; day: string; start_time: string } | null;
  lastInsightId: string | null;
  lastPlanId: string | null;
  planAwaitingApproval: boolean;
  history: Array<{ role: "user" | "assistant"; text: string }>;
}

export const newSession = (): SessionState => ({
  lastQuestionId: null,
  lastQuestionText: null,
  lastBriefingKey: null,
  pendingOffer: null,
  lastInsightId: null,
  lastPlanId: null,
  planAwaitingApproval: false,
  history: [],
});

export type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolCallRecord>;

/** Track conversation anchors (stable IDs) from tool results, whatever brain ran. */
export function absorb(state: SessionState, call: ToolCallRecord): void {
  const d = call.data ?? {};
  if (call.name === "get_daily_briefing") {
    const q = d.question as { id: string; text?: string } | null;
    state.lastQuestionId = q?.id ?? state.lastQuestionId;
    state.lastQuestionText = q?.text ?? state.lastQuestionText;
    const insights = (d.insights as Array<{ id: string }> | undefined) ?? [];
    if (insights[0]) state.lastInsightId = insights[0].id;
  }
  if (call.name === "propose_plan" && typeof d.plan_id === "string") {
    state.lastPlanId = d.plan_id;
    state.planAwaitingApproval = true;
  }
  if (call.name === "apply_plan" && !call.isError) state.planAwaitingApproval = false;
  if (call.name === "check_in") state.lastQuestionId = null;
  // "I'd look for a different slot — want me to find one?" must be honorable.
  if (call.name === "simulate_change" && d.recommendation === "reschedule") {
    const a = call.args as { title?: string; day?: string; start_time?: string };
    if (a.title && a.day && a.start_time) state.pendingOffer = { kind: "find_slot", title: a.title, day: a.day, start_time: a.start_time };
  } else if (call.name === "simulate_change") state.pendingOffer = null;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Honor the "find a different slot" offer with the same tool, one day at a time. */
async function findSlot(offer: NonNullable<SessionState["pendingOffer"]>, calls: ToolCallRecord[], callTool: CallTool): Promise<string> {
  const i = WEEKDAYS.findIndex((d) => d.toLowerCase() === offer.day.toLowerCase());
  const order = i < 0 ? WEEKDAYS : [...WEEKDAYS.slice(i + 1), ...WEEKDAYS.slice(0, i)];
  for (const day of order) {
    const call = await callTool("simulate_change", { title: offer.title, day, start_time: offer.start_time });
    calls.push(call);
    if (!call.isError && call.data?.recommendation === "safe") {
      return `${day} at ${offer.start_time} works for "${offer.title}" — no conflicts, and none of your goals lose their slot. Say "fix it" if you want it in a plan.`;
    }
  }
  return `I checked every other day at ${offer.start_time}: each one collides with something or costs a goal its slot. I'd skip "${offer.title}" this week, or try a different time.`;
}

// ---------------------------------------------------------------- rules brain
const YES = /^(yes|yeah|yep|do it|apply|go ahead|confirm|sure|ok(ay)?)\b/i;
const NO = /^(no|nope|not now|don'?t|no thanks|leave it|skip( it)?|later|maybe later)\b/i;
const SMALLTALK = /^(hi|hello|hey|yo|hiya|thanks?( you)?( a lot)?|thank you|cheers|ok(ay)?|cool|great|nice|never ?mind|forget it|bye|good ?night|see you|yes|yeah|yep|no|nope|not now)[!. ]*$/i;
const ANSWERED = "Thank you for telling me — I've noted it, and it changes how sure I am about what's going on. Say \"fix it\" when you want a plan.";
const CAPABILITIES = 'I can brief you on your week, explain an insight, fix your schedule with your approval, or test a "what if". What would you like?';

interface Route {
  match: RegExp;
  run: (m: RegExpMatchArray, state: SessionState) => { name: string; args: Record<string, unknown> } | null;
}

const ROUTES: Route[] = [
  // What-if simulation: "what (happens) if I take a client dinner on Thursday at 7pm"
  {
    match:
      /what (?:happens |would happen )?if i (?:take|accept|add|schedule|move|put|book|do|have|go to) (?:an? |the |my )?(.+?)(?: on| to)? (monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?: at (\d{1,2})(?::(\d{2}))?\s*(pm|am)?)?\??$/i,
    run: (m) => {
      let h = m[3] ? Number(m[3]) : 19;
      const ap = m[5]?.toLowerCase();
      if (ap === "pm" && h < 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
      return {
        name: "simulate_change",
        args: { title: m[1]!, day: m[2]!, start_time: `${String(h).padStart(2, "0")}:${m[4] ?? "00"}` },
      };
    },
  },
  // Self-reported savings progress ("I put in 450") -> logged against the house fund.
  { match: /(?:put in|put|saved|deposited|transferred|added)\s*\$?(\d+)/i, run: (m) => ({ name: "check_in", args: { content: m.input ?? m[0]!, goal_id: "goal_house", amount: Number(m[1]) } }) },
  // Routes are anchored or phrase-level on purpose: a free-text answer to
  // Align's question ("I don't know why, we barely talk") must not trip a route.
  { match: /\b(my )?goals?\b|\bstreaks?\b|goal progress|how am i doing on/i, run: () => ({ name: "get_goal_progress", args: {} }) },
  { match: /briefing|good morning|catch me up|how('s| is) my (week|day)|how am i doing( this week| today)?\??$|^what('s| is) (up|new)/i, run: () => ({ name: "get_daily_briefing", args: {} }) },
  { match: /\b(life |my )balance\b|how('s| is) my life|am i balanced|how am i (doing )?overall|^overall\??$/i, run: () => ({ name: "get_life_balance", args: {} }) },
  { match: /did it work|how did (my|the) week go|what('s| has) changed|\bresults\b/i, run: () => ({ name: "whats_changed", args: {} }) },
  { match: /remember (that )?(.+)/i, run: (m) => ({ name: "remember", args: { content: m[2]!, kind: "fact" } }) },
  // Spoken likes/dislikes become durable preferences the planner honors next time.
  {
    match: /\b(i )?(hate|love|prefer|would rather|don'?t like|dislike|not a fan of)\b.*\b(morning|evening|night|gym|spanish|date night)\b/i,
    run: (m) => ({ name: "remember", args: { content: m.input ?? m[0]!, kind: "preference" } }),
  },
  { match: /forget ([a-z]+_[a-z0-9]+)/i, run: (m) => ({ name: "forget", args: { memory_id: m[1]! } }) },
  { match: /what do you know about me|show (your |my )?memor/i, run: () => ({ name: "review_memory", args: {} }) },
  { match: /^(tell me more|why|explain|show me the evidence|what('s| is) the evidence)\b/i, run: (_m, s) => (s.lastInsightId ? { name: "get_insight", args: { insight_id: s.lastInsightId } } : null) },
  {
    match: /\b(fix (it|this|that|my (week|schedule))|make (me )?a plan|plan (it|my week)|suggest (something|changes|a plan)|help me change|sort (it|this) out)\b/i,
    run: (_m, s) => (s.lastInsightId ? { name: "propose_plan", args: { insight_id: s.lastInsightId } } : null),
  },
];

/** What makes a briefing "the same one": its headline, insights, balances and measured outcomes — not its wording. */
export function briefingKey(data: Record<string, unknown> | undefined): string {
  const d = data ?? {};
  const ids = ((d.insights as Array<{ id: string }> | undefined) ?? []).map((i) => i.id);
  const scores = ((d.balance as Array<{ domain: string; score: number | null }> | undefined) ?? []).map((b) => `${b.domain}=${b.score}`);
  const outcomes = ((d.outcomes as unknown[] | undefined) ?? []).length;
  return JSON.stringify([d.headline ?? null, ids, scores, outcomes]);
}

/** One-sentence recap built only from the briefing's own data. */
function briefingRecap(call: ToolCallRecord): string {
  const d = call.data ?? {};
  const headline = typeof d.headline === "string" ? d.headline : null;
  const balance = ((d.balance as Array<{ domain: string; score: number | null }> | undefined) ?? [])
    .filter((b) => typeof b.score === "number")
    .sort((a, b) => (a.score as number) - (b.score as number))
    .slice(0, 2)
    .map((b) => `${b.domain} at ${b.score}`);
  const parts = [headline, balance.length ? `lowest balances ${balance.join(" and ")}` : null].filter(Boolean);
  return `Nothing new since my last briefing${parts.length ? ` — ${parts.join("; ")}` : ""}. Say "fix it" for a plan, or "tell me more" for the evidence.`;
}

async function rulesBrain(text: string, state: SessionState, callTool: CallTool): Promise<OrchestratorReply> {
  const calls: ToolCallRecord[] = [];
  const say = (reply: string): OrchestratorReply => ({ reply, toolCalls: calls, brain: "rules" });

  if (state.planAwaitingApproval && YES.test(text.trim()) && state.lastPlanId) {
    const call = await callTool("apply_plan", { plan_id: state.lastPlanId, approve: true });
    calls.push(call);
    absorb(state, call);
    return say(call.text);
  }
  // Accept or decline a pending offer before anything else reads the "yes".
  if (state.pendingOffer && !state.planAwaitingApproval && (YES.test(text.trim()) || /^(find one|please do|go on)\b/i.test(text.trim()))) {
    const offer = state.pendingOffer;
    state.pendingOffer = null;
    return say(await findSlot(offer, calls, callTool));
  }
  if (state.pendingOffer && !state.planAwaitingApproval && NO.test(text.trim())) {
    state.pendingOffer = null;
    return say("Okay, leaving it.");
  }
  // Declining a proposed plan is a decision, not a memory: nothing is applied.
  if (state.planAwaitingApproval && NO.test(text.trim())) {
    state.planAwaitingApproval = false;
    return say('Okay — I\'ll leave your week as it is. Say "fix it" whenever you want the plan again.');
  }
  // Small talk and bare yes/no with nothing pending: conversation, never a memory,
  // and never mistaken for the answer to Align's open question.
  if (SMALLTALK.test(text.trim())) {
    // A bare yes/no while Align's question is open IS the answer — record it.
    if (state.lastQuestionId && (YES.test(text.trim()) || NO.test(text.trim()))) {
      const call = await callTool("check_in", { content: text, question_id: state.lastQuestionId });
      calls.push(call);
      absorb(state, call);
      return say(ANSWERED);
    }
    if (/^(thanks?|thank you|cheers)/i.test(text.trim())) return say("Any time.");
    if (/^(bye|good ?night|see you)/i.test(text.trim())) return say("Good night. I'll keep an eye on the week and speak up only if something matters.");
    if (/^(never ?mind|forget it)/i.test(text.trim())) return say("Okay, dropped.");
    if (YES.test(text.trim())) return say('Nothing is waiting on a yes right now. Say "fix it" if you\'d like a plan for the week.');
    if (NO.test(text.trim())) return say("Okay.");
    return say(state.lastQuestionText ? `Hi. ${state.lastQuestionText}` : 'Hi. Ask for your briefing, or say "fix it" when you want a plan.');
  }
  if (/^(help|what can you do)\b/i.test(text.trim())) return say(CAPABILITIES);
  // Direct calendar edits aren't a tool: be honest about how Align changes things.
  const savingsUpdate = /(put in|put|saved|deposited|transferred)\s*\$?\d+|\$?\d+ (in|into|to|toward) the/i.test(text);
  if (/^(move|reschedule|cancel|shift|put|book|schedule)\b/i.test(text.trim()) && !/^what if/i.test(text) && !savingsUpdate) {
    return say('I don\'t edit your calendar on command — I propose a plan and apply it only after your yes. Say "fix it" and I\'ll include that, or ask "what if…" to see the cost first.');
  }
  // Forget by description: look the memory up, then delete that one item.
  const forgetByText = text.match(/^forget (?:that |the |about )?(.+?)(?: thing| memory| one)?[.!?]*$/i);
  if (forgetByText && !/^[a-z]+_[a-z0-9]+$/i.test(forgetByText[1]!)) {
    const found = await callTool("review_memory", { filter: forgetByText[1]! });
    calls.push(found);
    const matches = (found.data?.memories as Array<{ id: string; content: string }> | undefined) ?? [];
    const quote = (c: string) => `"${c.replace(/[.!]+$/, "")}"`;
    if (matches.length === 0) return say("I don't hold a memory about that.");
    // Deleting is irreversible: only act when the description is unambiguous.
    if (matches.length > 1) {
      return say(`I have ${matches.length} memories mentioning that: ${matches.slice(0, 3).map((m) => quote(m.content)).join("; ")}. Say "forget" with the exact words of the one to delete.`);
    }
    const call = await callTool("forget", { memory_id: matches[0]!.id });
    calls.push(call);
    absorb(state, call);
    return say(`Forgotten: ${quote(matches[0]!.content)}.`);
  }
  // A wish or goal ("I want to…", "I'd like to…") is durable intent, not an
  // answer to the open question and not a passing check-in: keep it, and
  // point at the one thing Align can actually do about it.
  if (/^(i (really |just )?(want|need|wish|would like|would love)|i'?d (like|love)|my goal is)\b/i.test(text.trim())) {
    const call = await callTool("remember", { content: text, kind: "goal_note" });
    calls.push(call);
    absorb(state, call);
    return say("That's a goal worth planning around — I've kept it. Say \"fix it\" and I'll look for protected time for it this week; nothing changes without your yes.");
  }
  // While Align's question is open, a sentence-length statement is the answer —
  // even if it happens to contain a route word ("…the kids' goals and my plan").
  // Short, command-shaped turns ("fix it", "why?") still route normally.
  const wordCount = text.trim().split(/\s+/).length;
  const commandShaped = /^(what|how|why|tell|show|fix|give|can|could|did|do|is|are|remember|forget|help)\b/i.test(text.trim());
  if (state.lastQuestionId && wordCount >= 6 && !commandShaped) {
    const call = await callTool("check_in", { content: text, question_id: state.lastQuestionId });
    calls.push(call);
    absorb(state, call);
    return say(ANSWERED);
  }
  for (const route of ROUTES) {
    const m = text.match(route.match);
    if (!m) continue;
    let target = route.run(m, state);
    if (!target && !state.lastInsightId) {
      // No conversation anchor yet ("fix it" as the first words): fetch the
      // briefing to anchor on the top insight, then retry the route.
      const briefing = await callTool("get_daily_briefing", {});
      calls.push(briefing);
      absorb(state, briefing);
      target = route.run(m, state);
    }
    if (!target) continue;
    const call = await callTool(target.name, target.args);
    calls.push(call);
    absorb(state, call);
    // Same briefing as the one already delivered this session: recap, don't re-read it.
    if (call.name === "get_daily_briefing" && !call.isError) {
      const key = briefingKey(call.data);
      if (key === state.lastBriefingKey) return say(briefingRecap(call));
      state.lastBriefingKey = key;
    }
    return say(call.text);
  }
  // "What do you want to know?" -> Align's one open question, never a memory.
  if (/what (do|would) you (want|like) to know|ask me (something|anything)|(any|got) questions? for me/i.test(text)) {
    const briefing = await callTool("get_daily_briefing", {});
    calls.push(briefing);
    absorb(state, briefing);
    const q = (briefing.data?.question as { text?: string } | null)?.text;
    if (q) return say(`One thing I'd like to know: ${q}`);
    if (state.lastQuestionText) return say(`Earlier I asked: ${state.lastQuestionText} Whenever you're ready.`);
    if (state.lastQuestionId) return say("I've already asked my one question for today — answer it whenever you like.");
    return say("Nothing right now. I ask at most one question a day, and only when it would change what I do for you.");
  }
  // Questions aimed at Align ("can you listen?", "who are you?") are
  // conversation, not life facts — and not the answer to an open question.
  // Answer them without filing a memory.
  if (/\b(can|could|do|are|will|would) you (listen|hear)/i.test(text)) return say("I'm listening — go ahead.");
  if (/\b(who|what) are you\b/i.test(text)) return say(`I'm Align — I keep a model of your whole life and speak up when something matters. ${CAPABILITIES}`);
  if (/^(hey|hi|hello|ok|okay|so)?[,\s]*(can|could|do|are|will|would|what|who|how|why|where|when) you\b/i.test(text)) return say(CAPABILITIES);
  // Feelings are signal (recorded) — but deserve a human reply, not a receipt.
  if (/\b(i'?m|i am|i feel|feeling) (so |really |completely |totally )?(exhausted|tired|drained|burnt out|burned out|stressed|overwhelmed|anxious|sad|miserable|depressed)\b/i.test(text)) {
    const call = await callTool("check_in", state.lastQuestionId ? { content: text, question_id: state.lastQuestionId } : { content: text });
    calls.push(call);
    absorb(state, call);
    return say('I\'m sorry it\'s been that heavy. I\'ve noted it. If you want, say "fix it" and I\'ll look for room in the week — nothing changes without your yes.');
  }
  // Not a command: if Align asked something, this is the answer -> memory.
  if (state.lastQuestionId) {
    const call = await callTool("check_in", { content: text, question_id: state.lastQuestionId });
    calls.push(call);
    absorb(state, call);
    return say(ANSWERED);
  }
  // Any other question with no open question of Align's to answer: conversation, not a memory.
  if (/\?\s*$/.test(text)) return say(CAPABILITIES);
  const call = await callTool("check_in", { content: text });
  calls.push(call);
  absorb(state, call);
  return say(call.text);
}

// ---------------------------------------------------------------- entry point
export interface OrchestratorDeps {
  callTool: CallTool;
  bedrock?: (text: string, state: SessionState, callTool: CallTool) => Promise<OrchestratorReply>;
}

export async function orchestrate(
  text: string,
  state: SessionState,
  deps: OrchestratorDeps,
): Promise<OrchestratorReply> {
  state.history.push({ role: "user", text });
  let out: OrchestratorReply;
  if (deps.bedrock) {
    try {
      out = await deps.bedrock(text, state, deps.callTool);
    } catch (e) {
      console.warn(`bedrock brain failed (${(e as Error).message}); falling back to rules`);
      out = await rulesBrain(text, state, deps.callTool);
    }
  } else {
    out = await rulesBrain(text, state, deps.callTool);
  }
  state.history.push({ role: "assistant", text: out.reply });
  return out;
}
