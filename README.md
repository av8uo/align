# Align

**A proactive, cross-domain life-optimization agent for Alexa+**, built on the Model Context Protocol (spec 2025-11-25, Streamable HTTP).

Align watches where your life drifts from your stated values — across career, marriage & family, health, personal growth, and your financial goals — asks the one question that matters, proposes concrete fixes, executes them only with your approval, verifies every change, and measures whether it actually helped.

> Status: hackathon build in progress (Amazon Developer Hackathon 2026, Alexa+ track + AWS Builder mini challenge). Full README with architecture, certification-requirement mapping, and measured latency lands before submission.

## Tonight's slice
- SQLite schema (11 tables: events, goals, memory, insights, gaps, questions, plans, actions, outcomes)
- Seeded demo persona "Alex" — 3 weeks of history + a pre-filled current week, engineered so every detector (G1–G8) has real material
- Demo script: [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md)

## Run
```bash
npm install
npm test        # schema + demo-precondition tests
npm run seed    # writes data/lifeos.db (anchor date: LIFEOS_DEMO_TODAY, default 2026-10-19)
```

## License
MIT — see [LICENSE](LICENSE).
