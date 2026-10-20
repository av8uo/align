# Align — Demo Video Script (FINAL, < 3:00)

**Format:** screen recording of the simulator (`http://localhost:3344/sim`) with **"voice replies" ON** — Align's TTS is the agent's voice. Alex's lines are delivered by clicking the demo chips / typing (captions carry them), or speak them via the 🎙 mic if you prefer your own voice. Judges may stop at 3:00 — strongest material first; **every beat ends with something done.**

## Recording checklist (before pressing record)
1. `npm start` → open `http://localhost:3344/sim` in a clean browser window (hide bookmarks bar, 100% zoom, 1920×1080).
2. Click **↺ Reset** once, then **reload the page** — pristine day one.
3. Toggle ✅ voice replies ON. System volume up; capture desktop audio (OBS or Win+G Game Bar).
4. Do one silent rehearsal run, then Reset + reload again and record.
5. Record 1080p. Keep the mouse calm; move only to click.

---

## Cold open — 0:00–0:15
**Visual:** the simulator loading; the proactive briefing appears *by itself*.
**VO (you, or a caption):**
> *"Every AI waits for a question. Align doesn't. It holds a model of your whole life — and speaks first when something matters."*

## Beat 1 — It noticed, it connected, it asked — 0:15–0:55
**Action:** let the proactive briefing play fully (TTS).
**What the judges hear Align say, unprompted:** work crowding out family and personal goals *"— I'm not fully sure yet, but the pattern is there"* (uncertainty honesty), lowest balances, the rescheduled-4-times report, and ONE question: *"how are things with Sam lately?"*
**What they see:** Life Balance bars (family 6, red), the cross-domain insight card, the question chip.
**Caption overlay:** `Proactive · cross-domain · asks exactly one question`

**Action:** type → `Honestly we barely talk, work is eating everything.` → send.
**Align:** records it; reply invites "fix it".
**Caption:** `Your answer became evidence — confidence rose, the hedge is gone`

## Beat 2 — Correction → plan → approval → verified — 0:55–1:50
**Action:** click chip **"Actually, I hate morning gym"**.
**Align:** *"Preference saved — I'll plan around it from now on."*

**Action:** click **"Fix it"**.
**Align reads the plan:** workshop moved before Maya's recital, Date night Friday, **Gym at 18:00 — evenings, because you just said so**, two Spanish mornings, Call Mom Saturday. Trade-offs stated. *"This is an experiment — my hypothesis: … I'll measure it next week. Shall I apply it?"*
**Caption:** `It planned around a preference it learned 10 seconds ago`

**Action:** click **"Yes, do it"**.
**What they see:** the APPLIED card — every change with a green ✓, **ALL CHANGES VERIFIED** (re-read from the calendar after writing).
**Caption:** `Nothing executes without your yes · nothing is claimed without verification`

## Beat 3 — It thinks ahead of you — 1:50–2:05
**Action:** click chip **"What if I take a client dinner on Thursday at 7pm?"**
**Align:** *"…it collides with School recital — Maya at 18:00… I'd look for a different slot — want me to find one?"*
**Caption:** `The cost of a decision — computed BEFORE you make it`

## Beat 4 — One week later: it measured itself — 2:05–2:35
**Action:** click **⏭ One week later**.
**Align, proactively:** *"Results from last week's plan: family went 0 to 1, health 1 to 3, personal 0 to 2 — all improved."* … and the **next** knowledge gap: *"you wanted $500 into the house fund — how did October go?"*
**What they see:** MEASURED RESULTS card + Life Balance transformed (family 6 → 97).
**Action:** click chip **"I put in 450"** → Align: *"Logged. You're $50 short of the $500 target."*
**Caption:** `Hypothesis confirmed · outcomes retrain its probabilities · the agent is smarter this week than last`

## Beat 5 — Under the hood — 2:35–2:50
**Visual, fast cuts (pre-record separately):**
1. README: the functional-requirements coverage table (2 s)
2. **The same MCP server answering inside Claude** (4–5 s — proves a real, portable MCP integration, spec 2025-11-25, Streamable HTTP)
3. `src/engine/` file tree + the objective-function block from the README (3 s)
4. AWS: Bedrock + App Runner (architecture diagram) (3 s)
**VO/caption:** *"A real MCP server — deterministic engine decides, Claude on Bedrock speaks. 42 automated tests. Sub-500-millisecond tools."*

## Close — 2:50–3:00
**Visual:** the Life Balance wheel, all green.
**VO:**
> *"Align. It studies your life, computes the best move, acts with your consent — and proves it worked. **Alexa, open Align.**"*

---

## Extra clips for the Devpost page (not in the 3:00)
- **Echo Dot voice-only run:** toggle Echo Dot mode, run Beat 1–2 by audio alone (voice-only parity).
- **Honesty note on screen whenever the host is shown:** the badge "SIMULATED ALEXA+ HOST" is already in the UI — don't crop it out. It's a feature of the submission, not a flaw.
