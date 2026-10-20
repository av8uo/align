# Align — Demo Script (video spine, < 3:00)

Anchor date: Monday 2026-10-19 (`LIFEOS_DEMO_TODAY`). Persona: **Alex** — married to Sam, kids Maya & Leo, full-time job, goals: weekly date night, gym 3×, Spanish 3×, call Mom weekly, save $500/mo (house fund).

> Rule from certification guide: judges may stop at 3:00 — strongest material first. Every beat ends with something **done**.

## Cold open (0:00–0:15)
Screen: phone with 47 notifications vs an Echo Show on a kitchen counter.
VO: *"Every AI works for one request at a time. None of them watches your life drift away from what you said matters. Align does."*

## Beat 1 — The briefing that knows your whole life (0:15–1:00)
**Alex:** "Alexa, good morning."
→ `get_daily_briefing` (+ Life Balance widget renders)

**Align:** *"Morning, Alex. Your balance this week: career ran nine hours over. You and Sam haven't had an evening together in almost a month — against your weekly date-night goal. Spanish is untouched twelve days. And looking ahead: this week has zero gym slots, and Thursday's client workshop collides with Maya's school recital. One question — how are things with Sam lately?"*

Widget: **Life Balance wheel** — family/marriage dipping red, career ballooning, drift arrows. Forward-scan chip: "2 conflicts next 7 days".

**Alex:** "Honestly, we barely talk. Work is eating everything."
→ `check_in` — memory updated on screen ("experience recorded → linked to insight ins_001").

## Beat 2 — From insight to verified action (1:00–1:50)
**Alex:** "Fix it."
→ `propose_plan(ins_001)` → plan-diff widget

**Align:** *"Here's what I'd change: protect Friday 7 to 10 pm for you and Sam. Move Thursday's client workshop 90 minutes earlier so you make Maya's recital. Two Spanish mornings Tuesday and Friday. Your locked meetings don't move. Trade-off: your Wednesday deep-work block shifts to 1 pm."*

**Alex:** "Do it."
→ `apply_plan` — widget shows each change **verified ✓** against the calendar (re-read after write).

**Align:** *"Done and verified. Friday is yours and Sam's. I'll check how it went next week."*

## Beat 3 — It measures, remembers, adapts (1:50–2:20)
Time-jump card: "one week later" (`LIFEOS_DEMO_TODAY=2026-10-26`).
**Alex:** "Alexa, how did my week go?"
→ `whats_changed` + `get_goal_progress`

**Align:** *"Date night happened — first in a month. Spanish two of three. Gym still stuck at one, so next week I'll try mornings instead of evenings. And you wanted $500 into the house fund this month — how did October go?"*
**Alex:** "I put in 450."
→ `check_in` → *"Logged. $50 short but on pace for the year."*

## Beat 4 — Under the hood + portability (2:20–2:50)
Fast cuts: architecture diagram; **the same MCP server answering inside Claude** (10 s — proves a real, portable MCP integration, spec 2025-11-25, Streamable HTTP); deterministic engine code; `certification-requirement → how we meet it` README table; AWS Bedrock badge.
VO: *"Deterministic detectors decide. Bedrock explains. Every action approved, every result verified, every outcome measured — and it learns which plans actually work."*

## Close (2:50–3:00)
*"Align. The agent that lives where you live — and keeps your life pointed at what you said matters."*

---

## Echo Dot (voice-only) proof clip — for the submission page
Same Beat 1 by voice only: ≤5 spoken items, explicit "yes" before apply, no screen references. (Certification: voice-only parity.)

## Honesty slide (also in README)
Real: MCP server + engine + memory + verified execution + Bedrock reasoning. Simulated (labeled): the Alexa+ host — voice pipeline + proactive speech (no public add-on API for add-on-initiated turns → filed as feature request). Deferred: real calendar OAuth, multi-person Voice ID, finance advice (policy).
