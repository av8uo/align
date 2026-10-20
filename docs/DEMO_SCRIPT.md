# Align — Demo Video Script (FINAL, < 3:00, English)

**What the judges must see (Official Rules):** the project *functioning*, on the platform it's built for, in under three minutes, on a public YouTube/Vimeo link, in English, with no copyrighted music and no third-party trademarks you don't own. Our platform is an **MCP server (spec 2025-11-25, Streamable HTTP)** plus a **clearly labeled simulated Alexa+ experience** — both qualifying paths. Nothing in this video requires AWS or the internet: everything runs locally on the deterministic rules brain.

**Honesty rule for the video (say it, show it):** three kinds of things appear on screen and each is named as what it is —
1. **Implemented and running:** the MCP server, the 13 tools, the engine, verified execution, the learning loop, the tests.
2. **Simulated (labeled in the UI):** the Alexa+ host — voice pipeline, Echo Show/Dot frames, agent-initiated speech. The "SIMULATED ALEXA+ HOST" badge stays visible; never crop it.
3. **Deferred:** Claude-on-Bedrock as the live voice (integration implemented and tested; currently throttled by a new-account daily quota) and the public cloud deployment (script ready; not provisioned — we chose not to spend on hosting). Say this in one sentence; don't hide it, don't dwell on it.

**Format:** screen recording of `http://localhost:3344/sim` with **voice replies ON** — Align's TTS is the agent's voice. Alex's lines go in by clicking the demo chips or typing (captions carry them). Strongest material first: judges may stop at 3:00. **Every beat ends with something done.**

## Recording checklist
1. `npm start` → open `http://localhost:3344/sim` in a clean **Edge** window (best neural voices), bookmarks bar hidden, 100% zoom, 1920×1080.
2. `/healthz` in another tab must say `"status":"ok"` (brain can be `rules` or `bedrock` with the circuit open — the demo is identical).
3. Click **↺ Reset**, then **reload the page** — pristine day one. Toggle ✅ voice replies ON. System volume up.
4. Record with Win+G (Game Bar) capturing desktop audio, 1080p. One silent rehearsal, then Reset + reload and record for real.
5. Mouse calm; move only to click. No music. No logos other than the product's own UI.

---

## Cold open — 0:00–0:12
**Visual:** the simulator loading; the proactive briefing appears *by itself*.
**VO (you, or a caption):**
> *"Every AI waits for a question. Align doesn't. It holds a model of your whole life — and speaks first when something matters. This is a real MCP server for Alexa+, running locally, inside a simulated Alexa+ host."*
**Caption overlay:** `Real MCP server · Simulated Alexa+ host (labeled) · no cloud needed`

## Beat 1 — It noticed, it connected, it asked — 0:12–0:50
**Action:** let the proactive briefing play fully (TTS).
**What judges hear, unprompted:** work crowding out family and personal goals *"— I'm not fully sure yet, but the pattern is there"* (uncertainty honesty), the lowest balances, the report rescheduled four times, and ONE question: *"how are things with Sam lately?"*
**What they see:** Life Balance bars (family 6, red), the cross-domain insight card, the question chip.
**Caption:** `Proactive · cross-domain · asks exactly one question (expected value of information)`

**Action:** type → `Honestly we barely talk, work is eating everything.` → send.
**Align:** records it; invites "fix it".
**Caption:** `Your answer became evidence — confidence rose, the hedge is gone`

## Beat 2 — Correction → plan → approval → verified — 0:50–1:45
**Action:** click chip **"Actually, I hate morning gym"**.
**Align:** *"Preference saved — I'll plan around it from now on."*

**Action:** click **"Fix it"**.
**Align reads the plan:** workshop moved before Maya's recital, Date night Friday, **Gym at 18:00 — evenings, because you just said so**, two Spanish mornings, Call Mom Saturday. Trade-offs stated. *"This is an experiment — my hypothesis: … I'll measure it next week. Shall I apply it?"*
**Caption:** `It planned around a preference it learned 10 seconds ago · locked meetings never move`

**Action:** click **"Yes, do it"**.
**What they see:** the APPLIED card — every change with a green ✓, **ALL CHANGES VERIFIED** (re-read from the calendar after writing).
**Caption:** `Nothing executes without your yes · nothing is claimed without verification`

## Beat 3 — It thinks ahead of you — 1:45–2:00
**Action:** click chip **"What if I take a client dinner on Thursday at 7pm?"**
**Align:** *"…it collides with School recital — Maya at 18:00… I'd look for a different slot — want me to find one?"*
**Caption:** `The cost of a decision — computed BEFORE you make it`

## Beat 4 — One week later: it measured itself — 2:00–2:30
**Action:** click **⏭ One week later**.
**Align, proactively:** *"Results from last week's plan: family went 0 to 1, health 1 to 3, personal 0 to 2 — all improved."* … then the **next** knowledge gap: *"you wanted $500 into the house fund — how did October go?"*
**What they see:** MEASURED RESULTS card + Life Balance transformed.
**Action:** click chip **"I put in 450"** → Align: *"Logged. You're $50 short of the $500 target."*
**Caption:** `Hypothesis confirmed · outcomes retrain its probabilities · smarter this week than last`

## Beat 5 — Under the hood, honestly — 2:30–2:50
**Visual, fast cuts (pre-record separately, 4–5 s each):**
1. Terminal: `npm test` → **79 tests, 8 suites, all green** (engine, MCP wire, proactive quiet rule, Bedrock circuit breaker).
2. Terminal: `curl -X POST localhost:3344/mcp … tools/list` → the 13 tools in JSON — *the real Streamable HTTP endpoint*. (If you also show the server inside another MCP client, show only its tool list in a terminal/inspector — no third-party logos.)
3. README: the functional-requirements coverage table and the **real / simulated / deferred** honesty table.
4. `src/engine/` file tree + the objective-function block.
**VO:**
> *"A real MCP server — a deterministic engine decides, a language model only speaks. Claude on Amazon Bedrock is wired in as the orchestrator and tested with injected failures; today it's throttled by a new-account quota, so what you heard was the deterministic fallback through the same tools — by design, the demo never depends on the cloud. Seventy-nine automated tests. Tools answer in under five milliseconds."*
**Caption:** `Implemented: MCP server, engine, learning loop · Simulated: Alexa+ host · Deferred: Bedrock voice (quota), hosted deploy (cost)`

## Close — 2:50–3:00
**Visual:** the Life Balance wheel, all green, the SIMULATED badge still visible.
**VO:**
> *"Align. It studies your life, computes the best move, acts with your consent — and proves it worked. **Alexa, open Align.**"*

---

## Extra clip for the Devpost page (not in the 3:00)
- **Echo Dot voice-only run:** toggle Echo Dot mode, run Beat 1–2 by audio alone (voice-only parity).

## After recording
1. Upload to YouTube as **Public** (not unlisted), title "Align — proactive life agent for Alexa+ (MCP server) · Amazon Developer Hackathon 2026", English description with the repo link.
2. Paste the URL into the Devpost form and into [DEVPOST.md](DEVPOST.md).
