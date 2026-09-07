# TODO — Sentinel by Aftergraph (prototype-first, no code)

**Wedge guardrail:** Sentinel turns pull requests into merge-ready verdicts. First wedge: CLI review on exact HEAD → SHIP / DO NOT SHIP verdict with cited evidence → GitHub App.

## Prototype sprint (now)

- [ ] Verdict-card mock (Flow 2) against 1 real Aftergraph PR — static
- [ ] CLI output mock (Flow 1) with VERIFYING → verdict → STALE states — static
- [ ] 5-PR prototype validation runs (1 clean, 2 findings, 1 rebased, 1 dep bump) — manual, scored in validation-plan
- [ ] 20-rule gap list from public postmortems (validation-plan §2)
- [ ] Landing page/waitlist draft (headline + verdict visual + email capture)

## After prototype scores ≥4/5

- [ ] Confirm [VERIFY] markers against vendor docs → publishable comparison
- [ ] Auditor-acceptability memo (immutability, export, retention)
- [ ] CLI v0 scope: `review` command contract + rule-pack v0 (10 rules) + resolution memory
- [ ] GitHub App wrapper scope (verdict card update-in-place, rebase webhook)

## Optional later (explicitly NOT next)

- [ ] Interviews / outreach pipeline — optional later (reactivate only on Jonas approval)
- [ ] Pilot program with design partners
- [ ] Dashboard, SSO, EU residency, enterprise pack
- [ ] GitLab/Bitbucket adapters

## Done

- [x] Foundation docs (this set, 2026-09-07)
- [x] Brand decision: Sentinel by Aftergraph (decisions.md #1)
