# Align

**A high-intelligence life-improvement agent for Alexa+** — built on the Model Context Protocol (spec 2025-11-25, Streamable HTTP), with Claude on AWS Bedrock as its conversational brain.

> *Every AI answers questions. Align holds a living model of your whole life — your values, goals, relationships, commitments — analyzes it continuously, and makes it measurably better.*

Built for the **Amazon Developer Hackathon 2026** — Alexa+ track + AWS Builder mini challenge.

> ⚠️ **Platform status, up front:** the **MCP server is real** — spec 2025-11-25, Streamable HTTP, runs unchanged under any MCP host (we demo it inside Claude). The **Alexa+ host in our demo is simulated** (voice pipeline, device frames, and agent-initiated proactive speech), because Alexa+ add-on deployment is private-preview gated and no public API exists for add-on-initiated turns — that API is our #1 feature request. Every simulated element is labeled as such, in the demo UI and below.

---

## What it is

An **autonomous optimization agent** that maintains a persistent computational model of a person's life, continuously analyzes it for deviations between *stated values* and *observed behavior*, and executes verified interventions to close that gap — measuring its own efficacy and updating its learned probability estimates from the measured outcomes.

The control loop runs continuously, unprompted:

```
OBSERVE → MODEL → ANALYZE → INQUIRE → PLAN → EXECUTE → VERIFY → MEASURE → ADAPT
```

What that feels like as a user:

| Moment | Align says |
|---|---|
| Morning, proactively | *"Work ran late 4 evenings. You and Sam haven't had a night out in a month. One question — how are things with Sam lately?"* |
| You: "Fix it." | *"Protect Friday evening for you two, move Thursday's workshop before Maya's recital, two Spanish mornings. Locked meetings untouched. This is an experiment — I'll measure it."* |
| Before a decision | *"That client dinner collides with the recital — want a different slot?"* |
| One week later, proactively | *"Date night happened — first in a month. Hypothesis confirmed. And your house fund — how did October go?"* |
| When nothing's wrong | **Nothing.** Proactive ≠ interrupting. |

## The whole of your life — not a slice of it

Life areas are **configuration, not code** in Align's engine: the same detectors, correlator, and planner run over every domain. What that reasoning looks like, area by area:

| Life area | Align reasons like this — on its own |
|---|---|
| **Marriage & partnership** | *"No time together in 24 days against a weekly goal — and the displacing force is work evenings, not chance."* |
| **Children & family life** | *"Thursday's client workshop collides with Maya's school recital. One of them is movable. I moved the right one — after your yes."* |
| **Extended family** | *"'Call Mom' has slipped 16 days. Saturday 17:00 is free."* |
| **Friends & social life** | *"I have no fresh signal about your friends in three weeks — that's a knowledge gap worth one question."* → asks → protects a slot |
| **Health & energy** | *"Gym 1 of 3 last week, zero slots scheduled next week — and since you said you hate mornings, these are evening slots."* |
| **Personal growth** | *"Spanish untouched 12 days; two free mornings exist Tuesday and Friday."* |
| **Work & career management** | *"Four late evenings, ~9 hours over plan, deep work fragmented below 60-minute blocks — work is the source domain of three other deficits."* |
| **Business & long-term strategy** | *"Your quarterly strategy document has been rescheduled four times — a postponement chain. Protected a block before it slips a fifth."* |
| **Long-term financial goals** | *"You committed $500/month to the house fund; October logged $450 — $50 short, on pace for the year."* (Pacing arithmetic on **your** stated goals and **your** numbers — never investment advice.) |
| **Household operations** | Chore and maintenance cadences run on the same goal engine as everything else. |

**How these map to the scorecard:** the Life Balance scorecard scores **six domains** — `family` (marriage, children, extended family), `health`, `personal` (growth, learning, friends), `work` (career and business strategy), `household`, and `finance` (goal pacing). The ten areas above are lenses onto those six: each is expressed as goals, memories, and events inside one of the scored domains, analyzed by the same configurable engine. The demo persona exercises career ↔ marriage ↔ family ↔ health ↔ growth ↔ savings **end-to-end**; adding any other area is a goal definition, not new code.

## It thinks while no one is talking to it

The intelligence engine runs **on its own clock** — hourly in the background, plus after every new signal. Each cycle, unprompted: re-model the life-state → run all detectors over the past **and the next 7 days** → correlate across domains → measure outcomes of past interventions → update its learned probabilities → compute the single most valuable question to ask → draft the briefing. Then it speaks **only if something deserves attention** — a disciplined agent, not a notification machine.

## It gets measurably more intelligent every week

This is not a metaphor — it is the learning loop, in code ([src/engine/learn.ts](src/engine/learn.ts)):

```
choose the intervention maximizing:
  P(you accept it | your response history, per intervention kind)
× P(it actually improves the metric | measured outcomes of similar past interventions)
subject to: hard constraints (locked events, preferences, quiet hours)
```

Both probabilities are live, Laplace-smoothed estimates from Align's **own recorded history**: every plan declares a hypothesis, every outcome is measured a week later against baseline, every verdict rewrites the planner's weights, every spoken correction ("I hate morning gym") durably reshapes future plans, and every confirmed insight lifts the hedging from its speech. **Week one it reasons well about a stranger; week eight it reasons about *you*.**

## Core subsystems

1. **Life-State Model** — persistent world-model (SQLite): events, cadence goals, and an 8-type memory system (`fact | preference | goal_note | experience | pattern | hypothesis | commitment | outcome`), every item carrying confidence and provenance (`user_said` vs `engine_inferred`). Facts are never conflated with hypotheses.

2. **Deterministic Analysis Engine** — 8 pure-function detectors ([src/engine/detectors.ts](src/engine/detectors.ts)): goal-deficit, neglect, attention-drift (time-allocation vs value-ranking), overload, postponement-chains, data-staleness, financial pacing, and **forward-scan** — every detector also runs over the *future* week, so problems are caught before they happen. A cross-domain correlator ([src/engine/correlate.ts](src/engine/correlate.ts)) merges findings sharing evidence into composite insights (work↔family↔health↔growth) with full evidence chains.

3. **Expected-Value-of-Information Inquiry** ([src/engine/inquiry.ts](src/engine/inquiry.ts)) — the agent quantifies its own ignorance: gaps scored `0.5·severity + 0.4·(1−confidence) + 0.1·staleness − 0.3·declines`; exactly **one** question per briefing (argmax), filtered by a sensitive-topic blocklist, cooldowns, and quiet hours. Answers write back into the model and re-trigger analysis.

4. **Probabilistic Intervention Planner** ([src/engine/solver.ts](src/engine/solver.ts)) — a constraint solver (immovable events never move; slots honor stated preferences) where every candidate change is weighted `P(user accepts | history) × P(improves metric | measured outcomes)` — both Laplace-smoothed from the agent's own recorded history.

5. **Gated, Verified Execution** ([src/engine/executor.ts](src/engine/executor.ts)) — no mutation without explicit approval; after every write the executor **re-reads world state** and emits per-operation verification. Unverified success is never claimed. Every action is journaled.

6. **Outcome Measurement & Online Learning** ([src/engine/learn.ts](src/engine/learn.ts)) — every plan declares a hypothesis; one follow-up window later its metrics are recomputed against baseline and verdicted. Verdicts feed the planner's priors: **the agent is measurably different every week.**

7. **Counterfactual Simulator** — hypothetical state injection + full detector re-run = the cost of a decision, computed *before* it's made.

8. **Uncertainty-Honest Output** — insights below confidence 0.75 are verbally hedged (*"I'm not fully sure yet"*); a user confirmation lifts the hedge on the next turn.

## Architecture

**Hybrid neuro-symbolic, by design:** the deterministic core makes every decision — analysis, question choice, planning, scoring. The LLM (**Claude on AWS Bedrock**, agentic Converse tool-use loop — [src/sim/bedrock.ts](src/sim/bedrock.ts)) handles only language: intent → MCP tool calls → speech. Consequences:

- sub-500 ms tool latency (all heavy work precomputed by the engine)
- every decision auditable (it's code, not a prompt)
- graceful degradation: if Bedrock fails for any reason, a deterministic rules brain answers through the **same MCP wire** — tested with injected failures
- complies with Alexa+'s certification policy against thin LLM wrappers

```
┌─ Simulated Alexa+ host (/sim) ──────────────────────────────┐
│ mic → speech → ORCHESTRATOR (Claude on Bedrock | rules      │
│ fallback) → MCP client → voice out + Echo Show rendering    │
│ /proactive channel · time-jump · Echo Dot voice-only mode   │
└───────────────────────┬─────────────────────────────────────┘
                        │ MCP · Streamable HTTP · spec 2025-11-25
┌───────────────────────▼─────────────────────────────────────┐
│ Align MCP server — 13 typed tools (zod I/O), stateless,     │
│ structuredContent + stable-ID chaining (ins_* → plan_*)     │
├─────────────────────────────────────────────────────────────┤
│ Life Intelligence Engine (runs hourly, unprompted):         │
│ detectors → correlator → outcomes → EVI question → briefing │
├─────────────────────────────────────────────────────────────┤
│ Life-State Model (SQLite) — events · goals · memory ·       │
│ insights · plans · action journal · measured outcomes       │
└─────────────────────────────────────────────────────────────┘
```

The host is a stand-in for Alexa+ (deployment there is private-preview gated); the MCP server is real and host-independent — the same server answers inside Claude or any MCP client.

## The 13 MCP tools

| Tool | Customer intent |
|---|---|
| `get_daily_briefing` | "Good morning" / "how's my week looking" |
| `get_life_balance` | "How's my life going overall?" — six-domain scorecard |
| `get_insight` | "Tell me more / show the evidence" |
| `check_in` | Status updates, answers to Align's question, self-reported progress |
| `remember` / `review_memory` / `forget` | Durable facts; full memory transparency and deletion |
| `set_goal` / `get_goal_progress` | Goal management, streaks |
| `propose_plan` | "Fix it" — concrete changes + trade-offs + hypothesis |
| `apply_plan` | Execution, **only** with `approve=true` after an explicit yes |
| `simulate_change` | "What if I take a client dinner Thursday at 7?" |
| `whats_changed` | "Did it work?" — measured results, hypothesis verdict |

## Run it

Requirements: **Node.js ≥ 24** (uses the built-in `node:sqlite`), any OS. No AWS account, no API keys, no internet needed for the full demo.

```bash
npm install
npm test        # 85 tests across 9 suites — engine, MCP wire, proactive quiet rule, Bedrock circuit breaker
npm start       # http://localhost:3344/sim  (simulator) · /mcp (MCP endpoint) · /healthz · /stats
```

Demo flow in the simulator: the proactive briefing opens by itself → answer its question → **Fix it** → **Yes, do it** (watch per-change verification) → **⏭ One week later** → measured results + the adaptive next question → **↺ Reset** to run it again. Toggle **Echo Dot mode** for voice-only parity.

**Judges / testers — the MCP endpoint directly** (Streamable HTTP, spec 2025-11-25):

```bash
curl -X POST http://localhost:3344/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
curl -X POST http://localhost:3344/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_daily_briefing","arguments":{}}}'
```

Or point any MCP client (MCP Inspector, Claude Desktop, etc.) at `http://localhost:3344/mcp`.

**The host brain** — which LLM plays the Alexa+ role in the simulator (`LIFEOS_LLM` in `.env`):

| `LIFEOS_LLM` | Who understands you | Needs |
|---|---|---|
| `anthropic` | Claude via the Claude API ([src/sim/anthropic.ts](src/sim/anthropic.ts)) — the configuration used in the demo video | `ANTHROPIC_API_KEY` (cents per conversation) |
| `bedrock` | Claude on Amazon Bedrock ([src/sim/bedrock.ts](src/sim/bedrock.ts)) — the AWS Builder path | AWS credentials + Bedrock model access (see [docs/AWS_SETUP.md](docs/AWS_SETUP.md)) |
| unset | the deterministic rules brain — a regex router over the same tools | nothing |

Whatever the setting, any LLM failure (bad key, quota, refusal) falls back to the rules brain for that turn, through the same MCP tools, so the demo never dies. `/healthz` reports which brain is live; `/stats` reports per-tool latency. The engine's decisions are identical under all three — the LLM only converses.

### Test results (Oct 20, 2026)

```
Test Files  9 passed (9)
     Tests  85 passed (85)
```

Suites: `engine` (detectors, correlator, solver, learning), `schema`, `seed`, `mcp` (wire-level: full two-week demo arc over Streamable HTTP, latency budget asserted), `proactive` (quiet rule), `orchestrator` (LLM failure → rules fallback, conversation routing), `bedrock` (circuit breaker with injected transport), `anthropic` (Claude-API host loop with injected transport). Run `npm test` to reproduce.

## Alexa+ functional requirements coverage

Mapping of [Alexa+ functional requirements](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements) to implementation. This is **implementation evidence from our own tests** — not certification approval by Amazon, which requires their review:

| Requirement | How Align meets it |
|---|---|
| Every `tools/list` tool invocable; schemas validated | 13 tools, zod input **and** output schemas; wire-tested ([test/mcp.test.ts](test/mcp.test.ts)) |
| <500 ms round-trip | Tools serve precomputed state; hot-read latency asserted <500 ms in tests; live `/stats` endpoint |
| Stable IDs chain multi-step flows | `ins_* → plan_* → outcomes` chaining, tested end-to-end |
| Explicit confirmation before consequential action | `apply_plan` is approval-gated; unapproved calls return a confirmation prompt |
| No dead ends; errors give a next step; no technical jargon | MCP error contract everywhere; jargon-free error text asserted in tests |
| Context continuity; corrections update one parameter | Conversation anchors persist per session; answers update memory, not restart flows |
| Voice-only parity | ≤5 spoken items, read-back + explicit yes, no screen references; Echo Dot mode in simulator |
| Memory review & deletion (policy) | `review_memory` + `forget` tools |
| Not an LLM relay (policy) | Deterministic engine decides; LLM only phrases — see Architecture |
| Facts vs hypotheses | Confidence-tracked memory; hedged speech below threshold |
| Proactive without interrupting | `/proactive` quiet rule: silent when nothing needs attention (tested) |

## Honesty: real vs simulated vs deferred

| Real & working | Simulated (clearly labeled) | Deferred |
|---|---|---|
| MCP server (spec 2025-11-25), portable to any MCP host | The Alexa+ host: voice pipeline + **agent-initiated proactive speech** (no public API for add-on-initiated turns — filed as our #1 feature request) | Real calendar OAuth (`.ics`-style import + seeded data instead) |
| Engine, memory, verified execution, learning loop — 85 automated tests | Echo Show / Echo Dot device frames | Multi-person households (schema ready) |
| LLM host brain: Claude via the Claude API voices the demo video; the Bedrock integration (Converse tool-use loop, circuit breaker, fallback) is implemented and tested with injected failures | — | **Bedrock as the live voice:** at submission time every Bedrock call is throttled by a new-account daily token quota (AWS Support case filed), so the demo uses the Claude API path — same tools, same engine, different plumbing |
| Hourly background engine runs | — | **Hosted deployment:** the ECS Express Mode deploy script is complete and preflight-tested, but **not provisioned** — a deliberate no-cost decision; the project runs locally in two commands |
| — | — | Finance *advice* (policy); only user-stated goals with self-reported progress · Real Alexa+ deployment (private preview gated) |

### Known limitations
- Calendar and life data are seeded demo data (an `.ics`-style import), not a live calendar OAuth.
- The proactive channel, voice pipeline and device frames are a simulation of Alexa+ — there is no public API today for an add-on to initiate a turn.
- The Bedrock brain has not yet produced a live spoken turn in this account because of the day-one quota; its behavior is covered by unit tests with an injected transport. The demo video is voiced by the Claude-API host instead — identical role, identical tools.
- Single user, single household; English only.

## AWS (Builder mini challenge)

- **Amazon Bedrock** — Claude runs the agentic orchestration loop (Converse API with tool-use) in the Alexa+ host role.
- **ECS Express Mode (Fargate + ALB + HTTPS) + ECR** — containerized deployment ([Dockerfile](Dockerfile), [scripts/deploy-aws.ts](scripts/deploy-aws.ts)): one idempotent command builds, pushes, provisions roles, creates the service, waits for healthy, and only reports a URL once `/healthz` answers over HTTPS; `--check` is a read-only preflight with a cost estimate. (App Runner was the first target; it is closed to new AWS accounts — `SubscriptionRequiredException` — so the script was ported.) **Status: image pushed to ECR; service deliberately not provisioned** (≈ $45/month for a demo nobody needs hosted — the project runs locally).
- **Least-privilege IAM throughout** — no AdministratorAccess anywhere: the deploy key is pinned to one ECR repo, three named roles (with PassRole service conditions and an attach-policy pin to the two AWS-managed ECS policies), and read-only VPC preflight; the cloud container holds **no keys** — a task role scoped to `bedrock:InvokeModel`.
- **Quota discipline** — a circuit breaker in the Bedrock brain ([src/sim/bedrock.ts](src/sim/bedrock.ts)): one throttled call opens it until the quota window resets, every turn meanwhile is answered by the deterministic rules brain through the same MCP tools, and `/healthz` reports the breaker state honestly.

## License

MIT — see [LICENSE](LICENSE).
