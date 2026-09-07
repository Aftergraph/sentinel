# Jobs to be done — Sentinel by Aftergraph

**Wedge guardrail:** Sentinel turns pull requests into merge-ready verdicts. First wedge: CLI review on exact HEAD → SHIP / DO NOT SHIP verdict with cited evidence → GitHub App.

1. **"Tell me if this PR is safe to merge, and prove it."** — The core job. Output: verdict + cited evidence on exact HEAD. Nothing else counts.
2. **"Catch what rubber-stamping misses on boring PRs."** — Small diffs, dependency bumps, config changes. High volume, low attention, real blast radius.
3. **"Stop the merge when the base moved."** — Rebase/push during review must invalidate the verdict automatically, not silently.
4. **"Give the auditor the exact commit's review record."** — Exportable verdict history: who (which rule pack + model), what HEAD, which findings, what decision.
5. **"Enforce our rules without me reading every diff."** — Org rule packs (no unauthenticated routes, migrations need rollback, secrets patterns) as merge-blocking checks.
6. **"Don't waste my time with noise."** — No re-reported fixed findings, no style nits above the configured threshold, no praise paragraphs. Silence is a feature when the diff is clean (SHIP with checks listed, one line each).

Non-jobs (explicitly out): auto-fixing code, approving on the author's behalf without a human in the loop (post-MVP only with explicit policy), performance benchmarking.
