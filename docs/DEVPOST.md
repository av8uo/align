# Devpost Submission — Align (copy-paste pack)

Fill the Devpost form from the blocks below. Items marked ⏳ are finalized on submission day.

---

## Project name
**Align**

## Elevator pitch (short tagline)
A high-intelligence life-improvement agent for Alexa+: it holds a model of your whole life, thinks while you're not talking to it, speaks first when something matters, fixes your week with your consent — and measurably gets smarter about you every week.

## Track & mini challenge
- **Primary track:** Alexa+ — a working **MCP server** (spec 2025-11-25, Streamable HTTP) **plus** a simulated Alexa+ experience in a web app (both qualifying paths; the simulation's full source is in the repo, and the demo clearly shows it working).
- **Mini challenge:** AWS Builder — Amazon Bedrock (Claude, agentic Converse tool-use loop) as the orchestrator brain, implemented and tested (live calls are blocked on new accounts — AWS Support declined the quota increase, friction log F11); Amazon ECS Express Mode (Fargate + ALB) + ECR deployment script, preflight-tested (image pushed to ECR; service not provisioned, by cost choice); least-privilege IAM throughout. Details in the feedback answer and README.

## Links
- **Repository:** https://github.com/av8uo/align (MIT license; ⏳ flip to public at submission, or add reviewers `testing@devpost.com`, `chris-trag`, `knmeiss`, `giolaq`, `anishamalde`, `mosesroth`, `emersonsklar` as collaborators)
- **Demo video:** https://youtu.be/ow4dWSlrSDw (public, English, 2:49)
- **Live demo:** none hosted (deliberate no-cost decision — the ECS Express Mode deploy script is complete and preflight-tested). **Testing instructions:** Node ≥ 24 → `npm install && npm start` → http://localhost:3344/sim; MCP endpoint at `/mcp` (curl examples in the README). No AWS account or keys needed.

---

## About the project (long description)

### Inspiration
Every assistant we use waits for a question, answers it, and forgets. But the hardest problem in a real life isn't getting answers — it's **drift**. Work quietly eats the evenings. The gym goal dies in week two. "Call Mom" slips a month. Date night disappears, and nobody notices, because noticing patterns across a whole life is a full-time job.

Most startups build agents that connect to our apps, our phones, our devices. We wanted the agent that connects to **us** — our health, our family, our private life — and makes it measurably better. That is Align.

### What it does
Align is a proactive life agent for Alexa+. It keeps a living model of your whole life — values, goals, people, commitments, calendar, and memories with confidence scores — and runs one loop over it, unprompted:

**MEET → REMEMBER → NOTICE → ASK → PLAN → ACT (only with your yes) → VERIFY → MEASURE → LEARN**

- **It meets you with a blank mind.** A new user gets an interview, not guesses: one question per turn, every answer stored live as a fact, a goal or a preference you can review or delete.
- **It thinks while you're not talking to it.** An engine runs 8 deterministic detectors over the past *and the next 7 days*, links findings across areas (work ↔ family ↔ health ↔ growth), and speaks first only when something deserves it. A quiet rule keeps it silent otherwise.
- **It knows what it doesn't know.** Knowledge gaps are discovered from your data and scored by how much the answer would change a decision. It asks at most one question a day, rotates across life areas so it keeps learning about all of you, and hedges out loud until your answer confirms an insight.
- **It fixes the week — with consent and proof.** One plan across every area: locked meetings never move, learned preferences ("I hate morning gym") are respected, nothing executes without your yes, and every change is verified by re-reading the calendar.
- **It thinks ahead.** "What if I take a client dinner Thursday at 7?" → it simulates the week and tells you the real cost ("collides with Maya's recital") before you commit.
- **It measures honestly, then learns.** Scheduled is not done. A week later it picks up the thread — *"You told me you hate morning gym, so gym moved to evenings. How many sessions happened?"* — and only confirmed evidence moves the Life Balance score. Confirmed and missed sessions retrain what it proposes next.

It covers the whole of life: partnership, children, extended family, friends, health, personal growth, career, long-term projects, financial goals (pacing on your own numbers — never investment advice) and the household.

### How we built it
- **Deterministic core, language at the surface.** A TypeScript engine makes every decision — detection, correlation, question selection, planning, scoring, verification. The language model only converses. Tools answer in milliseconds, every decision is auditable, and Align is not a thin LLM wrapper.
- **A real MCP server:** 13 typed tools (zod input *and* output schemas), stateless Streamable HTTP, spec 2025-11-25.
- **Claude as the Alexa+ orchestrator:** it reads the tool catalog, chains tool calls and phrases the speech — over **Amazon Bedrock** (Converse tool-use loop, implemented and tested) or the **Claude API** (live in the demo). A deterministic rules brain takes over if the model is unavailable.
- **A simulated Alexa+ host, clearly labeled:** Echo Show frame, voice in and out, an agent-initiated proactive channel with a quiet rule, a time jump, and an Echo Dot voice-only mode — because add-on deployment is in private preview and no public API exists yet for agents that speak first.
- **AWS, least privilege:** a Docker image in Amazon ECR and a one-command ECS Express Mode deployment (Fargate, ALB, HTTPS, health checks) with a read-only preflight — not provisioned for the submission, by cost choice. The container holds zero keys.
- **146 automated tests in 16 suites:** wire-level MCP tests that replay the full demo and assert the latency budget, injected-failure tests for every host brain, and an evaluation suite for the intelligence itself.

### Challenges we ran into
1. **No API for proactive agents on Alexa+.** Add-ons can only answer. Our core idea — an agent that speaks first — can't ship on today's platform, so we built the host channel ourselves, labeled it, and made it our #1 feature request.
2. **A brand-new AWS account is a gauntlet.** A hidden use-case form, an undocumented one-time Marketplace permission, an opaque "Too many tokens per day" throttle, and an App Runner error that reads like a paywall. Our Bedrock quota request ended with AWS Support saying new accounts stay limited until they build billing history. Every incident is written up as a friction log with verbatim errors — and because the engine never depended on one model, we switched the voice to the Claude API without touching a single decision.
3. **Honesty under pressure.** The easy path was letting the agent claim a plan "worked". We forced it to say "I can't tell yet" and ask — which is what made the learning loop real.

### Accomplishments that we're proud of
- An agent that **provably learns**: a spoken preference changes the very next plan, and a week later only confirmed evidence changes the score.
- **The quiet rule**: a proactive agent disciplined enough to say nothing.
- **Honesty built in**: simulated parts labeled, uncertainty spoken aloud, unknown never counted as success.
- Engine, MCP server, host, deployment, tests and docs — shipped inside the hackathon window.

### What we learned
Deterministic cores with language surfaces beat prompt-only agents wherever trust matters: latency, auditability, certification and honesty. A proactive agent's hardest skill isn't speaking first — it's knowing when to stay quiet, and when to say "I don't know yet." And the best product feedback comes from building with least privilege on a brand-new account: the paths the docs' authors never walk.

### What's next for Align
Align has one goal: **every part of your life at ten out of ten.** Here is the road there.

1. **Ship on real Alexa+.** Move from our simulated host to a certified Alexa+ add-on the moment agent-initiated turns open to developers — the same MCP server runs unchanged, and we delete our simulator with joy.
2. **Connect to real life, with consent.** Calendar OAuth so plans land where you actually live, and optional health and sleep signals from wearables you choose to share — so "health" is measured, not guessed.
3. **Whole households.** Voice ID tells Align who is speaking: one memory, one set of goals and one privacy boundary per person — and plans that coordinate a family: the school run, the date night, the call to the grandparents.
4. **Show, don't just tell.** An Echo Show widget (MCP Apps) for the Life Balance, the weekly plan, and the evidence behind every insight.
5. **Privacy as a feature.** Your life model belongs to you: export, delete, per-area sharing, encryption at rest by default.
6. **Prove the outcome.** A pilot with real families to measure the only question that matters: after eight weeks with Align, do people spend their time closer to what they say they value?
7. **Grow the engine.** New detectors (sleep debt, social isolation, early burnout signals), plans that learn what each person really does, and an open, auditable engine others can build on.

The future of assistants isn't answering faster. It's an agent that knows your life, cares about all of it, and quietly helps you live it better. **That's Align.**

## Built with
`typescript` · `node.js` · `model-context-protocol` · `node:sqlite` · `zod` · `vitest` · `claude` · `amazon-bedrock` · `amazon-ecs` · `aws-fargate` · `amazon-ecr` · `docker` · `web-speech-api`

## Product feedback (form field)
Full version in the repo: [docs/SUBMISSION_FEEDBACK.md](SUBMISSION_FEEDBACK.md) — product feedback on all six tools used (Alexa+ MCP Toolkit & docs, MCP TypeScript SDK, Amazon Bedrock, Claude API, App Runner → ECS Express Mode/ECR/IAM, node:sqlite), **eleven friction-log entries with verbatim errors** (including AWS Support declining Bedrock capacity for a new account), and seven feature requests led by: an add-on-initiated proactive-turns API for Alexa+ MCP add-ons.

## If the project existed before
It did not — every line was written inside the submission window (first commit Oct 19, 2026).
