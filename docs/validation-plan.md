# Validation plan — Sentinel by Aftergraph

**Wedge guardrail:** Sentinel turns pull requests into merge-ready verdicts. First wedge: CLI review on exact HEAD → SHIP / DO NOT SHIP verdict with cited evidence → GitHub App.

## Method: desk research + prototype validation (no outreach pipeline)

1. **Competitor desk research.** Confirm all **[VERIFY]** markers in `competitor-analysis.md` against first-party vendor docs (CodeRabbit, Greptile, Copilot, Sonar, CodeScene). One afternoon, produces the publishable comparison.
2. **Rule-pack gap analysis.** List 20 merge-blocking rules from public postmortems (unauth routes, missing rollbacks, secret leaks, N+1, unindexed migrations). If Sentinel's v0 rule model covers 15+, the wedge holds.
3. **Prototype validation (5 real PRs).** Run the verdict-card mock + manual CLI-shape review against 5 real Aftergraph PRs (1 clean, 2 with real findings, 1 rebased mid-review, 1 dependency bump). Score: verdict correct? evidence cited file:line? rebase invalidated? Record misses publicly in the repo.
4. **Passive waitlist.** Landing page with verdict-card visual + "CLI first, App second" + email capture. No launch, no ads — measures pull.
5. **Legal/compliance desk check.** What makes a verdict record auditor-acceptable (immutability, export format, retention)? One memo, informs data-model-v0, not a feature yet.

## Interviews / pilot: OPTIONAL LATER

Direct interviews, outreach copy, pilot pipeline are explicitly **not** next actions — optional later. Reactivate only after prototype validation scores 4/5 or better and the waitlist shows pull.
