# Sentinel by Aftergraph

**Product core:** Sentinel by Aftergraph is a verified code-review product that turns pull requests into merge-ready verdicts.

**First wedge:** CLI review on exact HEAD → SHIP / DO NOT SHIP verdict with cited evidence → GitHub App. No code yet — this repo is strategy docs only.

## Why Sentinel exists

AI review comments are cheap; merge confidence is not. Existing reviewers (CodeRabbit, Copilot, Sonar) comment probabilistically: they can review a stale HEAD, re-report fixed findings, and approve what they never verified. Sentinel's contract is different — **a verdict is only issued against the exact commit it verified, and a stale base invalidates the verdict automatically.**

## Docs index

| Doc | What it decides |
|---|---|
| `docs/market-research.md` | Who bleeds from bad merges, how much it costs |
| `docs/competitor-analysis.md` | Governance-first comparison, moat per competitor |
| `docs/go-to-market.md` | Self-host CLI (free distribution) → GitHub App → hosted team tier |
| `docs/brand-identity.md` | Why Sentinel, naming, voice |
| `docs/personas.md` | CTO, staff engineer, solo maintainer, compliance lead |
| `docs/jobs-to-be-done.md` | The 6 jobs Sentinel is hired for |
| `docs/validation-plan.md` | Desk research + prototype validation; interviews optional later |
| `docs/ui-flows.md` | CLI output, PR comment shape, verdict card |
| `docs/data-model-v0.md` | Review, Verdict, EvidenceRef, RulePack |
| `docs/risks.md` | What kills this product |
| `docs/decisions.md` | Locked decisions + what needs owner approval |
| `docs/todo.md` | Prototype-first backlog, no code yet |
| `docs/roadmap-90-days.md` | B (CLI) → A (GitHub App) sequencing |

## Recommended next execution

Prototype sprint: verdict-card mock + CLI output contract against 5 real PRs (manual runs, no automation). Then landing page/waitlist draft. Interviews/pilot are **optional later** — not active next actions.
