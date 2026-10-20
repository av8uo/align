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
  brain: "bedrock" | "anthropic" | "rules";
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

import { classifyIntent } from "./intent.js";

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
  // A check-in closes the open question — unless the tool asked for clarification (ambiguous completion answer).
  if (call.name === "check_in" && !call.data?.clarification_needed) { state.lastQuestionId = null; state.lastQuestionText = null; }
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
// Deterministic fallback. Every turn is classified into ONE intent (src/sim/intent.ts)
// and each intent has its own action and its own kind of reply — never "check_in
// for everything" and never the same line for unrelated inputs. It reflects the
// user's words, uses stored knowledge, and asks at most one focused question.
// Its limits are real: no language understanding beyond these patterns.
const CAPABILITIES = 'I can brief you on your week, explain an insight, fix your schedule with your approval, or test a "what if". What would you like?';
const clean = (t: string) => t.trim().replace(/[.!?]+$/, "");
const lower1 = (t: string) => (t ? t[0]!.toLowerCase() + t.slice(1) : t);

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

/** Has Align already offered a plan this session? (Offer once; after that, wait to be asked.) */
const offeredPlan = (state: SessionState) => state.history.some((h) => h.role === "assistant" && /\b(fix it|a plan)\b/i.test(h.text));

async function rulesBrain(text: string, state: SessionState, callTool: CallTool): Promise<OrchestratorReply> {
  const calls: ToolCallRecord[] = [];
  const say = (reply: string): OrchestratorReply => ({ reply, toolCalls: calls, brain: "rules" });
  const run = async (name: string, args: Record<string, unknown>) => {
    const call = await callTool(name, args);
    calls.push(call);
    absorb(state, call);
    return call;
  };
  const planHint = () => (offeredPlan(state) ? "" : ' Say "fix it" when you want a plan.');
  const { intent, payload } = classifyIntent(text, state);

  switch (intent) {
    case "approve_plan": {
      const call = await run("apply_plan", { plan_id: state.lastPlanId, approve: true });
      return say(call.text);
    }
    case "reject_plan": {
      state.planAwaitingApproval = false;
      if (state.lastPlanId) await run("apply_plan", { plan_id: state.lastPlanId, approve: false, reject: true });
      return say('Okay — I\'ll leave your week as it is. Say "fix it" whenever you want the plan again.');
    }
    case "accept_offer": {
      const offer = state.pendingOffer!;
      state.pendingOffer = null;
      return say(await findSlot(offer, calls, callTool));
    }
    case "decline_offer":
      state.pendingOffer = null;
      return say("Okay, leaving it.");
    case "greeting":
      return say(state.lastQuestionText ? `Hi. ${state.lastQuestionText}` : 'Hi. Ask for your briefing, or say "fix it" when you want a plan.');
    case "thanks":
      return say("Any time.");
    case "goodbye":
      return say("Good night. I'll keep an eye on the week and speak up only if something matters.");
    case "nevermind":
      return say("Okay, dropped.");
    case "stray_yes":
      return say("Nothing is waiting on a yes right now. Say \"fix it\" if you'd like a plan for the week.");
    case "stray_no":
      return say("Okay.");
    case "help":
      return say(CAPABILITIES);
    case "meta_complaint": {
      // The user is right that repetition is on us: drop the open question for this session, keep the gap for later.
      const q = state.lastQuestionText;
      state.lastQuestionId = null;
      state.lastQuestionText = null;
      return say(q ? "You're right — I already asked that. Dropping it; I'll only come back to it if it changes what I'd plan." : "Fair — I'll stop repeating myself.");
    }
    case "know_query": {
      const call = await run("review_memory", {});
      return say(call.text);
    }
    case "want_question": {
      const briefing = await run("get_daily_briefing", {});
      const q = (briefing.data?.question as { text?: string } | null)?.text;
      if (q) return say(`One thing I'd like to know: ${q}`);
      if (state.lastQuestionText) return say(`Earlier I asked: ${state.lastQuestionText} Whenever you're ready.`);
      if (state.lastQuestionId) return say("I've already asked my one question for today — answer it whenever you like.");
      return say("Nothing right now. I ask at most one question a day, and only when it would change what I do for you.");
    }
    case "agent_question":
      if (payload.listen) return say("I'm listening — go ahead.");
      if (payload.who) return say(`I'm Align — I keep a model of your whole life and speak up when something matters. ${CAPABILITIES}`);
      return say(CAPABILITIES);
    case "support": {
      // Acknowledge what was actually said; no tool, no intervention unless asked.
      const clause = lower1(clean(String(payload.clause)));
      const open = state.lastQuestionText ? ` When you're ready: ${state.lastQuestionText}` : "";
      return say(`That's a lot — ${clause}. I'm listening, and I won't turn this into a plan unless you ask.${open}`);
    }
    case "whatif": {
      const call = await run("simulate_change", { title: payload.title, day: payload.day, start_time: payload.start_time });
      return say(call.text);
    }
    case "savings_progress": {
      const call = await run("check_in", { content: text, goal_id: "goal_house", amount: payload.amount });
      return say(call.text);
    }
    case "forget_text": {
      const found = await run("review_memory", { filter: payload.filter });
      const matches = (found.data?.memories as Array<{ id: string; content: string }> | undefined) ?? [];
      const quote = (c: string) => `"${c.replace(/[.!]+$/, "")}"`;
      if (matches.length === 0) return say("I don't hold a memory about that.");
      if (matches.length > 1) return say(`I have ${matches.length} memories mentioning that: ${matches.slice(0, 3).map((m) => quote(m.content)).join("; ")}. Say "forget" with the exact words of the one to delete.`);
      await run("forget", { memory_id: matches[0]!.id });
      return say(`Forgotten: ${quote(matches[0]!.content)}.`);
    }
    case "completion": {
      const call = await run("check_in", { content: text, completions: [{ title: payload.title, status: payload.status, count: payload.count, ...(payload.day ? { day: payload.day } : {}) }] });
      return say(call.text);
    }
    case "preference": {
      const call = await run("remember", { content: text, kind: "preference" });
      if (call.isError) return say(`I couldn't keep that: ${call.text}`);
      const d = call.data ?? {};
      if (d.duplicate) return say("I already have that — it's shaping every plan.");
      if (d.supersedes_id) return say(`${call.text} The next plan will follow the new one.`);
      const p = payload.parsed as { subject: { kind: string; keyword?: string; domain?: string } | null; polarity: string; time: string };
      const what = p.subject ? (p.subject.keyword ?? p.subject.domain) : "your sessions";
      const when = p.polarity === "like" ? p.time : p.time === "morning" ? "evening" : "morning";
      return say(`Noted — ${what} go in the ${when} from now on.${state.planAwaitingApproval ? ' Say "fix it" and I\'ll redo the pending plan around it.' : ""}`);
    }
    case "goal_update": {
      const goals = await run("get_goal_progress", {});
      const list = (goals.data?.goals as Array<{ goal_id: string; title: string; domain: string }> | undefined) ?? [];
      const subj = String(payload.subject ?? "").toLowerCase().replace(/^(the |my )/, "");
      const goal = list.find((g) => g.title.toLowerCase().includes(subj) || subj.includes(g.title.toLowerCase().split(" ")[0]!));
      if (!goal) return say(`I don't have a goal matching "${payload.subject}". Say "set a goal: <name>, <n> times a week" and I'll track it.`);
      const call = await run("set_goal", { title: goal.title, domain: goal.domain, cadence_per_week: payload.cadence });
      state.planAwaitingApproval = false; // any pending plan was built on the old target
      return say(`${call.text}${state.lastPlanId ? " The plan I proposed was built on the old target, so I've set it aside — say \"fix it\" for a new one." : ""}`);
    }
    case "correction":
    case "fact": {
      const call = await run("remember", { content: text, kind: "fact" });
      if (call.isError) return say(`I couldn't keep that: ${call.text}`);
      const d = call.data ?? {};
      if (d.duplicate) return say("I have that already.");
      if (d.supersedes_id) return say(`Corrected — ${lower1(clean(text))}. I've replaced what I had.`);
      return say(`Noted — ${lower1(clean(text))}.`);
    }
    case "goal_note": {
      const call = await run("remember", { content: text, kind: "goal_note" });
      if (call.isError) return say(`I couldn't keep that: ${call.text}`);
      if (call.data?.duplicate) return say("That's already on my list.");
      return say(`That's a goal worth planning around — I've kept it.${planHint()}`);
    }
    case "direct_edit":
      return say('I don\'t edit your calendar on command — I propose a plan and apply it only after your yes. Say "fix it" and I\'ll include that, or ask "what if…" to see the cost first.');
    case "advice": {
      // Advice is grounded in the current insight, never improvised.
      if (!state.lastInsightId) await run("get_daily_briefing", {});
      if (!state.lastInsightId) return say("I don't see anything in your data that needs changing right now, so I'd hold course.");
      const ins = await run("get_insight", { insight_id: state.lastInsightId });
      return say(`${ins.text.replace(/ Say "fix it" and I'll propose a plan\.$/, "")} If you want, I'll turn that into concrete changes — say "fix it".`);
    }
    case "route": {
      const tool = String(payload.tool);
      const m = payload.match as RegExpMatchArray;
      if (tool === "remember") { const call = await run("remember", { content: m[2], kind: "fact" }); return say(call.data?.duplicate ? "I have that already." : `Noted — ${lower1(clean(String(m[2])))}.`); }
      if (tool === "forget") { const call = await run("forget", { memory_id: m[1] }); return say(call.text); }
      if (tool === "get_insight" || tool === "propose_plan") {
        if (!state.lastInsightId) await run("get_daily_briefing", {}); // anchor on the top insight first
        if (!state.lastInsightId) return say(tool === "propose_plan" ? "I don't see anything that needs fixing right now." : "I have nothing to explain yet — ask for your briefing first.");
        const call = await run(tool, tool === "get_insight" ? { insight_id: state.lastInsightId } : { insight_id: state.lastInsightId });
        return say(call.text);
      }
      const call = await run(tool, {});
      if (tool === "get_daily_briefing" && !call.isError) {
        const key = briefingKey(call.data);
        if (key === state.lastBriefingKey) return say(briefingRecap(call));
        state.lastBriefingKey = key;
      }
      return say(call.text);
    }
    case "ambiguous_answer": {
      // Don't close the question on a hedge; ask the one thing that resolves it — and
      // don't repeat the same sentence if the user hedged twice.
      const last = state.history.filter((h) => h.role === "assistant").at(-1)?.text ?? "";
      if (!state.lastQuestionText) return say("I'm not sure what you mean — could you say it another way?");
      if (/A yes, a no, or a number is enough\.$/.test(last)) return say("I'll leave it unrecorded rather than guess. If you remember later, just tell me.");
      return say(`No rush. ${state.lastQuestionText} A yes, a no, or a number is enough.`);
    }
    case "question_answer": {
      const call = await run("check_in", { content: text, question_id: state.lastQuestionId });
      if ((call.data?.completions_recorded as string[] | undefined)?.length || call.data?.clarification_needed) return say(call.text);
      return say(`Thanks for telling me — ${lower1(clean(text))}. That changes how sure I am about what's going on.${planHint()}`);
    }
    case "statement": {
      const call = await run("check_in", { content: text });
      return say(`Noted — ${lower1(clean(text))}.${planHint()}`);
    }
    case "off_topic_question":
      return say("That's outside what I know — I only hold your calendar, your goals and what you've told me. Ask me about your week, or say \"fix it\" for a plan.");
    case "unclear":
    default:
      return say("I'm not sure what you'd like — your briefing, a plan, or to tell me something?");
  }
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
