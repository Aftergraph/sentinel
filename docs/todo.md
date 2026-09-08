# TODO — Sentinel by Aftergraph

**Wedge guardrail:** Sentinel turns pull requests into merge-ready verdicts. First wedge: CLI review on exact HEAD → `SHIP` / `DO_NOT_SHIP` / `STALE` with cited evidence → GitHub App.

**Current implementation cut:** `main@c09eb714ea3e5ff8449e8c4059826ed156bb307c`. The CLI, receipts, policy/override paths, isolated verify-run, MCP, GitHub App wrapper, console and context graph are implemented in-repo. The current deterministic rule pack is **v1.7.0 / 26 rules** (`lib/rulepack.js`).

Read `docs/evidence-status.md` before quoting prototype or dogfood scores. The old manual 15/15 baseline, historical six-rule CLI replay (2/5), and live-fire exit-code proofs are different evidence classes.

## Evidence sprint — now

- [ ] **Re-run the five historical PR cases with rule-pack v1.7.0.** Record Sentinel exact HEAD, target PR head/base SHAs, command, exit, receipt id and findings. Do not recycle the six-rule `prototype/dogfood-results.md` result as current evidence.
- [ ] **Re-prove exit 0 / 1 / 2 at current Sentinel HEAD.** The existing `prototype/livefire-results.md` proves behavior at HEAD `4b0007c`; current-head proof remains open.
- [ ] **Treat STALE as a controlled live condition, not a static replay label.** Reproduce a mid-review base move or record `NOT_REPRODUCED`.
- [ ] **Build a pinned precision corpus** with expected per-rule labels, false positives and misses. Aggregate accuracy without per-rule error accounting is insufficient.
- [ ] **Capture a real GitHub App installation/webhook delivery** against an exact PR head. Mocked tests remain implementation/test evidence, not production-delivery evidence.

## Product / governance gates

- [ ] Confirm remaining `[VERIFY]` competitor markers against vendor documentation before publishing comparison claims.
- [ ] Write auditor-acceptability memo covering receipt immutability, retention, export, evidence linkage and override/break-glass semantics.
- [ ] Define the repository release gate for calling the GitHub App `production-ready` rather than merely implemented/tested.
- [ ] Reconcile public site/docs claims against `docs/evidence-status.md` after every stronger evidence result.

## Completed implementation milestones

- [x] Verdict-card mock and CLI output-state mock.
- [x] Manual five-PR reasoning baseline (`prototype/5pr-validation.md`) — **manual prototype evidence only**, 15/15 human-scored axes.
- [x] Historical real CLI dogfood replay with original six-rule pack (`prototype/dogfood-results.md`) — 2/5 historical expected verdict matches, misses documented.
- [x] Live-fire proof of exit 1 and exit 2 at Sentinel HEAD `4b0007c` (`prototype/livefire-results.md`).
- [x] Deterministic rule-pack registry through v1.7.0 — 26 rules.
- [x] CLI review, JSON/SARIF/governance output, receipts/ledger and offline receipt verification.
- [x] Policy-scoped review, explicit verdict override and resolution memory.
- [x] Isolated verify-run pipeline and sealed evidence paths.
- [x] Read-only MCP judge/tools.
- [x] GitHub App webhook/verdict-card/check-run implementation with mocked test coverage.
- [x] Local Console views and org-state surfaces.
- [x] Context graph / blast-radius analysis as additive context, never verdict authority.
- [x] Landing/marketing source exists in-repo.

## Optional later

- [ ] Interviews / outreach pipeline — reactivate only on explicit owner decision.
- [ ] Pilot program with design partners after the current empirical gates are useful enough to justify asking humans for their time.
- [ ] SSO, EU residency and enterprise administration.
- [ ] GitLab / Bitbucket adapters.

## Rule

A source file existing is `implemented`. A passing test is `tested`. A real external interaction is `live-proven`. A pinned evaluated corpus is `validated on corpus`. None of those labels automatically implies the next one.
