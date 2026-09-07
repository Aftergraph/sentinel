# Sentinel by Aftergraph

**Product core:** Sentinel by Aftergraph is a verified code-review product that turns pull requests into merge-ready verdicts.

**First wedge:** CLI review on exact HEAD → SHIP / DO NOT SHIP verdict with cited evidence → GitHub App. CLI v0 ships in this repo (`bin/sentinel.js`, rule-pack v1.2.0: 21 deterministic rules, see `docs/rulepack-v1.2.md`).

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

## CLI quickstart

```
npm install -g @aftergraph/sentinel   # Node >= 20, no build step
sentinel review --pr 42               # human verdict, exit 0 SHIP / 1 DO NOT SHIP / 2 STALE
sentinel review --pr 42 --format json # Review + Verdict + Findings per docs/data-model-v0.md
sentinel review --pr 42 --format sarif > results.sarif
sentinel review --pr 42 --format gov > gov.json   # ci-result-shaped verdict (docs/receipts-v0.1.md)
sentinel review --pr 42 --rule-pack 1.0.0  # pinned original 6-rule pack
sentinel verify --receipt ./receipt.json   # offline VALID/INVALID check
git diff | sentinel review --diff - --repo myorg/myrepo  # local mode, no GitHub needed
sentinel --help
```

Every review appends a content-addressed receipt to `~/.sentinel/ledger.jsonl`
(`docs/receipts-v0.1.md`) — re-running the same HEAD yields the same receipt id.

Beyond the CLI: `sentinel-mcp` (read-only MCP judge for coding-agent loops,
`docs/mcp.md`), `apps/github` (S1 webhook → verdict card, mocked tests),
and the platform vision (`docs/vision-software-verification-platform.md`,
`docs/roadmap-S0-S10.md`, Cloudflare hosting in `docs/cloudflare.md`).

## Console (local web UI, PWA-ready)

```
node bin/sentinel.js serve --port 8787
# open http://127.0.0.1:8787 in a browser
```

Board, run, rules, config, ledger views over the same verdict engine —
what the UI shows is byte-identical to the CLI (`docs/console-v1-design.md`).
Binds 127.0.0.1 by default; remote bind requires `--token` or
`SENTINEL_CONSOLE_TOKEN`.

CI gate (GitHub Actions — gate on exit code: 0 pass, 1 fail, 2 re-run, never treat 2 as failure):

```yaml
- run: sentinel review --pr ${{ github.event.pull_request.number }} --format json
```

## Recommended next execution

Prototype sprint: verdict-card mock + CLI output contract against 5 real PRs (manual runs, no automation). Then landing page/waitlist draft. Interviews/pilot are **optional later** — not active next actions.
