# Personas — Sentinel by Aftergraph

**Wedge guardrail:** Sentinel turns pull requests into merge-ready verdicts. First wedge: CLI review on exact HEAD → SHIP / DO NOT SHIP verdict with cited evidence → GitHub App.

## 1. Mette, CTO (buyer)

Runs a 20-person team, paged twice this quarter for bad merges. Buys confidence, not comments. Needs: org-wide rule packs, audit export for the board, a number that goes down (revert rate). Will not touch per-comment pricing.

## 2. Jonas, staff engineer (user, champion)

Reviews 10 PRs/day, rubber-stamps half. Wants: a verdict he can trust on the boring PRs so his attention goes to the risky ones. Needs CLI in his own workflow first — will not adopt a dashboard that adds clicks.

## 3. Priya, solo OSS maintainer (distribution)

200 stars, 5 drive-by PRs/week. Pays with attention. Needs: free App on public repos, zero config, verdicts that cite file:line so she can merge from her phone. Her public verdicts are our ads.

## 4. Henrik, compliance lead (enterprise wedge)

Needs proof that *exact commit X* was reviewed against rule pack Y by an independent layer — for the auditor, not the team. Needs: tamper-evident verdict history, export, EU residency. Arrives in phase 3, pays the most, moves the slowest.
