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
  lastInsightId: string | null;
  lastPlanId: string | null;
  planAwaitingApproval: boolean;
  history: Array<{ role: "user" | "assistant"; text: string }>;
}

export const newSession = (): SessionState => ({
  lastQuestionId: null,
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
    const q = d.question as { id: string } | null;
    state.lastQuestionId = q?.id ?? state.lastQuestionId;
    const insights = (d.insights as Array<{ id: string }> | undefined) ?? [];
    if (insights[0]) state.lastInsightId = insights[0].id;
  }
  if (call.name === "propose_plan" && typeof d.plan_id === "string") {
    state.lastPlanId = d.plan_id;
    state.planAwaitingApproval = true;
  }
  if (call.name === "apply_plan" && !call.isError) state.planAwaitingApproval = false;
  if (call.name === "check_in") state.lastQuestionId = null;
}

// ---------------------------------------------------------------- rules brain
const YES = /^(yes|yeah|yep|do it|apply|go ahead|confirm|sure|ok(ay)?)\b/i;

interface Route {
  match: RegExp;
  run: (m: RegExpMatchArray, state: SessionState) => { name: string; args: Record<string, unknown> } | null;
}

const ROUTES: Route[] = [
  // Self-reported savings progress ("I put in 450") -> logged against the house fund.
  { match: /(?:put in|saved|deposited|transferred)\s*\$?(\d+)/i, run: (m) => ({ name: "check_in", args: { content: m.input ?? m[0]!, goal_id: "goal_house", amount: Number(m[1]) } }) },
  { match: /briefing|good morning|catch me up|how('s| is) my (week|day)/i, run: () => ({ name: "get_daily_briefing", args: {} }) },
  { match: /balance|how('s| is) my life|am i balanced|overall/i, run: () => ({ name: "get_life_balance", args: {} }) },
  { match: /did it work|how did (my|the) week go|what('s| has) changed|results/i, run: () => ({ name: "whats_changed", args: {} }) },
  { match: /goal|streak|progress/i, run: () => ({ name: "get_goal_progress", args: {} }) },
  { match: /remember (that )?(.+)/i, run: (m) => ({ name: "remember", args: { content: m[2]!, kind: "fact" } }) },
  { match: /forget ([a-z]+_[a-z0-9]+)/i, run: (m) => ({ name: "forget", args: { memory_id: m[1]! } }) },
  { match: /what do you know about me|show (your |my )?memor/i, run: () => ({ name: "review_memory", args: {} }) },
  { match: /tell me more|why|evidence|explain/i, run: (_m, s) => (s.lastInsightId ? { name: "get_insight", args: { insight_id: s.lastInsightId } } : null) },
  { match: /fix|plan|suggest|help me change|sort (it|this) out/i, run: (_m, s) => (s.lastInsightId ? { name: "propose_plan", args: { insight_id: s.lastInsightId } } : null) },
];

async function rulesBrain(text: string, state: SessionState, callTool: CallTool): Promise<OrchestratorReply> {
  const calls: ToolCallRecord[] = [];
  const say = (reply: string): OrchestratorReply => ({ reply, toolCalls: calls, brain: "rules" });

  if (state.planAwaitingApproval && YES.test(text.trim()) && state.lastPlanId) {
    const call = await callTool("apply_plan", { plan_id: state.lastPlanId, approve: true });
    calls.push(call);
    absorb(state, call);
    return say(call.text);
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
    return say(call.text);
  }
  // Not a command: if LifeOS asked something, this is the answer -> memory.
  if (state.lastQuestionId) {
    const call = await callTool("check_in", { content: text, question_id: state.lastQuestionId });
    calls.push(call);
    absorb(state, call);
    return say(`${call.text} That helps me connect the dots — say "fix it" when you want a plan.`);
  }
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
