# Align

**A high-intelligence life-improvement agent for Alexa+** — built on the Model Context Protocol (spec 2025-11-25, Streamable HTTP), with Claude on AWS Bedrock as its conversational brain.

> *Every AI answers questions. Align holds a living model of your whole life — your values, goals, relationships, commitments — analyzes it continuously, and makes it measurably better.*

Built for the **Amazon Developer Hackathon 2026** — Alexa+ track + AWS Builder mini challenge.

---

## What it is

An **autonomous optimization agent** that maintains a persistent computational model of a person's life, continuously analyzes it for deviations between *stated values* and *observed behavior*, and executes verified interventions to close that gap — measuring its own efficacy and retraining its decision weights on the results.

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

```bash
npm install
npm test        # 42 tests across 6 suites — engine, MCP wire, proactive, resilience
npm start       # http://localhost:3344/sim  (simulator) · /mcp (MCP endpoint) · /healthz · /stats
```

Demo flow in the simulator: the proactive briefing opens by itself → answer its question → **Fix it** → **Yes, do it** (watch per-change verification) → **⏭ One week later** → measured results + the adaptive next question → **↺ Reset** to run it again. Toggle **Echo Dot mode** for voice-only parity.

Bedrock brain: set AWS credentials + `LIFEOS_LLM=bedrock` (see [docs/AWS_SETUP.md](docs/AWS_SETUP.md)); without it the deterministic rules brain serves the full demo. `/stats` reports live per-tool latency.

## Alexa+ certification readiness

Mapping of [Alexa+ functional requirements](https://developer.amazon.com/docs/alexaplus/add-ons/functional-requirements) to implementation:

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
| Engine, memory, verified execution, learning loop — 42 automated tests | Echo Show / Echo Dot device frames | Multi-person households (schema ready) |
| Bedrock brain (authorization verified live; new-AWS-account day-one token quotas may throttle — fallback keeps the demo alive, by design) | — | Finance *advice* (policy); only user-stated goals with self-reported progress |
| Hourly background engine runs | — | Real Alexa+ deployment (private preview gated) |

## AWS (Builder mini challenge)

- **Amazon Bedrock** — Claude runs the agentic orchestration loop (Converse API with tool-use) in the Alexa+ host role.
- **App Runner + ECR** — containerized public deployment ([Dockerfile](Dockerfile), [scripts/deploy-aws.ts](scripts/deploy-aws.ts)): one idempotent command builds, pushes, provisions roles, deploys, waits for healthy.
- **Least-privilege IAM throughout** — no AdministratorAccess anywhere: the deploy key is pinned to one ECR repo, two named roles (with PassRole service conditions and an attach-policy pin), and the lifeos App Runner service; the cloud container holds **no keys** — an instance role scoped to `bedrock:InvokeModel` on the specific model ARNs.

## License

MIT — see [LICENSE](LICENSE).
