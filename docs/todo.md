# TODO — Sentinel by Aftergraph (current validation and execution backlog)

**Wedge guardrail:** Sentinel turns pull requests into merge-ready verdicts. First wedge: CLI review on exact HEAD → SHIP / DO NOT SHIP verdict with cited evidence → GitHub App.

## Prototype sprint (now)

- [x] Verdict-card mock (Flow 2) against 1 real Aftergraph PR — static — evidence: `prototype/verdict-card-mock.md` (71698f3; merge 9d2a4b9)
- [x] CLI output mock (Flow 1) with VERIFYING → verdict → STALE states — static — evidence: `prototype/cli-output-mock.md` (3 states, STALE exit 2)
- [ ] 5-PR prototype validation runs (1 clean, 2 findings, 1 rebased, 1 dep bump) — manual, scored in validation-plan — OPEN, owner: human (manual runs; draft at `prototype/5pr-validation.md` 15/15 static, dogfood replay only 2/5)
- [x] 20-rule gap list from public postmortems (validation-plan §2) — evidence: `prototype/rule-gap-list.md` (20 rules, v0 covers 16/20)
- [x] Landing page/waitlist draft (headline + verdict visual + email capture) — evidence: `landing/draft.md` (merge b794062)

## After prototype scores ≥4/5

- [ ] Confirm [VERIFY] markers against vendor docs → publishable comparison — OPEN, owner: human (vendor-doc confirmation; markers still unconfirmed in `docs/competitor-analysis.md`)
- [ ] Auditor-acceptability memo (immutability, export, retention) — OPEN, owner: human (no memo file yet; only `docs/data-model-v0.md` immutable-records note)
- [x] CLI v0 scope: `review` command contract + deterministic rule packs + resolution memory — current source truth: `lib/rulepack.js` v1.7.0 (26 rules) + `lib/memory.js` + `bin/sentinel.js` review/policy/override/verify-run; prior pack versions remain pinned
- [x] GitHub App wrapper scope (verdict card update-in-place, rebase webhook) — evidence: `apps/github/card.js` (CARD_MARKER update-in-place) + `apps/github/app.js` webhook

## Optional later (explicitly NOT next)

- [ ] Interviews / outreach pipeline — optional later (reactivate only on Jonas approval)
- [ ] Pilot program with design partners
- [ ] Dashboard, SSO, EU residency, enterprise pack
- [ ] GitLab/Bitbucket adapters

## Done

- [x] Foundation docs (this set, 2026-09-07)
- [x] Brand decision: Sentinel by Aftergraph (decisions.md #1)
