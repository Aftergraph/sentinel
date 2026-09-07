# Market research — Sentinel by Aftergraph

**Wedge guardrail:** Sentinel turns pull requests into merge-ready verdicts. First wedge: CLI review on exact HEAD → SHIP / DO NOT SHIP verdict with cited evidence → GitHub App.

## Who bleeds from bad merges

1. **Teams with 5-50 engineers merging 20+ PRs/day.** Review latency is the bottleneck; rubber-stamping is the norm. One bad merge costs 2-8 engineer-hours (revert, hotfix, incident channel).
2. **Solo maintainers of popular OSS.** Drive-by PRs with subtle breakage; maintainer attention is the scarcest resource.
3. **Regulated teams (fintech, health, gov).** Need evidence that *this exact commit* was reviewed — a comment thread is not an audit trail.

## Sizing (directional, desk research — verify before publishing)

- CodeRabbit publicly reports 1M+ developers on platform (vendor claim, 2025-2026). Market exists and pays.
- SonarQube dominates compliance-driven shops; its review UX is rules-based, not verdict-based.
- The gap: nobody sells **exact-head merge confidence with cited evidence** as the product. All incumbents sell comments.

## Willingness to pay signals

- Teams already pay $15-25/seat/mo for review tooling (market norm, verify against vendor pricing pages before publishing).
- The buyer is the CTO/eng lead who has been paged for a bad merge — budget opens after incidents, not before.
- OSS maintainers pay with attention, not money: free tier for public repos is distribution, not revenue.

## What this means for Sentinel

Price against the incident, not the comment: per-seat team tier only after the free CLI proves verdicts on the buyer's own repos. No enterprise sales motion before 10 design-partner teams.
