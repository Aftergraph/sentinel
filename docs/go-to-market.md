# Go-to-market — Sentinel by Aftergraph

**Wedge guardrail:** Sentinel turns pull requests into merge-ready verdicts. First wedge: CLI review on exact HEAD → SHIP / DO NOT SHIP verdict with cited evidence → GitHub App.

## Channel order (self-host is free distribution, not the cheap option)

1. **Self-host CLI (free, day 1).** `sentinel review <pr>` — single binary, 5-minute install, runs in CI. This is the distribution arm: every OSS repo that runs it advertises verdicts on its PRs.
2. **GitHub App (free for public repos).** One-click install, verdict card on PRs, links back to the CLI for self-hosters. Conversion surface, not the product.
3. **Hosted team tier ($19-49/seat/mo, directional).** Only when it beats "$20-VPS + CLI" on TCO: SSO, org-wide rule packs, verdict history/audit export, EU residency, support.
4. **Enterprise later.** Regulated buyers need the audit chain + independence story (see competitor-analysis: Copilot cannot own "independent").

## Why this order

CodeRabbit owns the marketplace channel; out-distributing them head-on is suicide. The CLI-first path goes where they cannot follow without shrinking comment volume (their revenue proxy). Dogfood on Aftergraph's own repos from sprint 1 — every verdict is public proof.

## What we do NOT do

- No enterprise sales motion before 10 design-partner teams on the App.
- No per-comment pricing (perverse incentive, contradicts the verdict contract).
- No interviews/outreach pipeline as next step — validation is desk research + prototype runs + passive waitlist. Interviews **optional later**.
