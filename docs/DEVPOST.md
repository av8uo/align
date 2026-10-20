# Devpost Submission — Align (copy-paste pack)

Fill the Devpost form from the blocks below. Items marked ⏳ are finalized on submission day.

---

## Project name
**Align**

## Elevator pitch (short tagline)
A high-intelligence life-improvement agent for Alexa+: it holds a model of your whole life, thinks while you're not talking to it, speaks first when something matters, fixes your week with your consent — and measurably gets smarter about you every week.

## Track & mini challenge
- **Primary track:** Alexa+ — a working **MCP server** (spec 2025-11-25, Streamable HTTP) **plus** a simulated Alexa+ experience in a web app (both qualifying paths; the simulation's full source is in the repo, and the demo clearly shows it working).
- **Mini challenge:** AWS Builder — Amazon Bedrock (Claude, agentic Converse tool-use loop) as the orchestrator brain; Amazon ECS Express Mode (Fargate + ALB) + ECR for the public deployment; least-privilege IAM throughout. Details in the feedback answer and README.

## Links
- **Repository:** https://github.com/av8uo/align (MIT license; ⏳ flip to public at submission, or add reviewers `testing@devpost.com`, `chris-trag`, `knmeiss`, `giolaq`, `anishamalde`, `mosesroth`, `emersonsklar` as collaborators)
- **Demo video:** ⏳ YouTube URL (public, English, <3:00)
- **Live demo:** none hosted (deliberate no-cost decision — the ECS Express Mode deploy script is complete and preflight-tested). **Testing instructions:** Node ≥ 24 → `npm install && npm start` → http://localhost:3344/sim; MCP endpoint at `/mcp` (curl examples in the README). No AWS account or keys needed.

---

## About the project (long description)

### Inspiration
Every AI we tried — including the newest agents — waits to be asked, answers, and forgets. Meanwhile the hardest problem people have isn't getting answers: it's that **life drifts**. Work quietly eats the evenings; the gym goal dies in week two; "call Mom" slips a month; the strategy document gets rescheduled a fifth time. Nobody notices the pattern, because noticing patterns across your whole life is a full-time job. We built the agent whose full-time job it is.

### What it does
Align maintains a persistent computational model of a person's life — values, goals, relationships, commitments, calendar, memories with confidence scores — and runs a continuous loop over it, **unprompted**:

**OBSERVE → MODEL → ANALYZE → INQUIRE → PLAN → EXECUTE → VERIFY → MEASURE → ADAPT**

- **It thinks while no one is talking to it:** an hourly background engine runs 8 deterministic detectors over the past *and the next 7 days* (problems get caught before they happen), correlates findings across domains (work ↔ marriage ↔ health ↔ growth), and prepares a briefing — then speaks **only** if something deserves attention.
- **It knows what it doesn't know:** knowledge gaps are scored by expected value of information; it asks exactly **one** question ("How are things with Sam lately?"), never touches sensitive topics, and your answer becomes evidence that raises or lowers its confidence — which you can *hear*: uncertain insights are verbally hedged until confirmed.
- **It fixes the week — with consent and proof:** a constraint solver proposes concrete calendar changes (locked meetings never move; slots honor learned preferences like "I hate morning gym"), every plan declares a measurable hypothesis, nothing executes without an explicit yes, and every change is **verified by re-reading the calendar** after writing.
- **It thinks ahead of you:** "What if I take a client dinner Thursday at 7?" → it simulates the alternate week and answers with the real cost ("collides with Maya's recital") *before* you commit.
- **It gets measurably more intelligent every week:** one week after a plan executes, its metrics are re-measured against baseline; verdicts update two learned probability estimates — P(you accept this kind of change) and P(it actually works) — that weight every future proposal.

It spans the whole of life, not a slice: marriage & partnership, children, extended family, friends & social life, health, personal growth, career & workload, business strategy & long-term projects, long-term financial goals (pacing on *your* stated numbers — never investment advice), and household operations. Life areas are configuration, not code.

### How we built it
- **Hybrid neuro-symbolic architecture:** a deterministic TypeScript engine makes every decision (detection, correlation, question selection, planning, scoring) — the LLM only converses. This keeps tools under 500 ms (Alexa+'s budget), makes every decision auditable, and honors Alexa+'s policy against thin LLM wrappers.
- **MCP server:** 13 typed tools (zod input *and* output schemas), stateless Streamable HTTP per spec 2025-11-25, stable-ID chaining for multi-step flows. The identical server runs under our simulated host *and* inside Claude.
- **Claude on Amazon Bedrock** plays the Alexa+ orchestrator role: reads the MCP tool catalog, chains tool calls (Converse API tool-use loop), and phrases the speech. A deterministic rules brain answers through the same MCP wire if Bedrock is unavailable — tested with injected failures.
- **The simulated Alexa+ host:** Echo Show frame, TTS/mic, a proactive channel with a strict quiet rule, a demo time-jump, and an Echo Dot voice-only mode. Clearly labeled simulated, because add-on deployment is private-preview gated and no public API exists for agent-initiated speech — which became our #1 feature request.
- **AWS deployment:** Dockerized, one idempotent script (ECR push + ECS Express Mode: Fargate, ALB, HTTPS, health checks; `--check` = read-only preflight with cost estimate). Least-privilege everywhere: the deploy key is pinned to one repo and three named roles; the cloud container holds **zero keys** (task role scoped to `bedrock:InvokeModel`). The image is in ECR; we chose **not** to provision the service for the submission (≈ $45/month for a demo that runs locally in two commands). A quota circuit breaker means one throttled Bedrock call switches the server to the rules brain until the quota window resets — no wasted requests, no dead demo.
- **Honest status of the Bedrock brain:** implemented (Converse tool-use loop over the 13 MCP tools) and tested with an injected transport; in our day-old AWS account every live call is still throttled by the daily token quota (Support case filed), so the demo video shows the deterministic rules brain speaking through the same tools.
- **79 automated tests**, including wire-level MCP tests that run the entire two-week demo arc and assert the latency budget, and injected-failure tests for the Bedrock circuit breaker.

### Challenges we ran into
1. **No API for proactive agents on Alexa+.** Add-ons can only respond. Our core concept — an agent that speaks first — cannot ship on today's platform, so we built the host channel ourselves, labeled it honestly, and filed the feature request.
2. **A brand-new AWS account is a gauntlet.** Four distinct Bedrock failures before the first successful Claude call (hidden use-case form, undocumented one-time `aws-marketplace:Subscribe` requirement, opaque day-one token quotas) and an App Runner error that reads like a paywall — our founder literally asked *"should I pay maybe something?"* — which turned out to mean App Runner is closed to new accounts, so we ported the deployment to ECS Express Mode mid-hackathon. All incidents are written up as friction logs with verbatim errors.
3. **Least-privilege IAM for real.** We refused AdministratorAccess on principle; deriving the exact 7-statement policy (including the easy-to-miss `ecr:BatchGetImage` and the ECS service-linked-role permission) took three iterations — also documented as friction.

### Accomplishments we're proud of
- A **provably learning agent**: the demo shows a spoken correction changing the very next plan, and a measured "hypothesis confirmed" one week later — not claimed, tested.
- The **quiet rule**: a proactive agent disciplined enough to say nothing.
- Shipping the whole thing — engine, server, host, deployment, docs — in 4 days, with honesty tables instead of hype.

### What we learned
Deterministic cores + LLM surfaces beat prompt-only agents on every axis that matters here: latency, auditability, certification policy, and trust. And: the best product feedback comes from building with least privilege on a day-old account — the paths the docs' authors never walk.

### What's next
Real calendar OAuth; multi-person households on Voice ID (schema is ready); the MCP Apps interactive widget for Echo Show; and — the moment Amazon ships agent-initiated turns — deleting our simulator with great joy.

## Built with
`typescript` · `node.js` · `model-context-protocol` · `node:sqlite` · `zod` · `vitest` · `claude` · `amazon-bedrock` · `amazon-ecs` · `aws-fargate` · `amazon-ecr` · `docker` · `web-speech-api`

## Product feedback (form field)
Full version in the repo: [docs/SUBMISSION_FEEDBACK.md](SUBMISSION_FEEDBACK.md) — product feedback on all five tools used (Alexa+ MCP Toolkit & docs, MCP TypeScript SDK, Amazon Bedrock, App Runner → ECS Express Mode/ECR/IAM, node:sqlite), **eight friction-log entries with verbatim errors**, and six feature requests led by: an add-on-initiated proactive-turns API for Alexa+ MCP add-ons.

## If the project existed before
It did not — every line was written inside the submission window (first commit Oct 19, 2026).
