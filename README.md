# Sentinel by Aftergraph

**Product core:** Sentinel by Aftergraph is a verified code-review product that turns pull requests into merge-ready verdicts.

**First wedge:** CLI review on exact HEAD → SHIP / DO NOT SHIP verdict with cited evidence → GitHub App. CLI v0 ships in this repo (`bin/sentinel.js`, rule-pack v1.5.0: 24 deterministic rules, see `docs/rulepack-v1.5.md`).

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
| `docs/policy.md` | Policy-file format reference + `review --policy` scoping semantic |
| `docs/pipeline.md` | Verify pipeline: planning, isolated runner, sealed evidence, `verify run`, org registry |
| `docs/mcp.md` | MCP server tools (14, read-only) + client setup |
| `docs/receipts-v0.1.md` | Receipt/ledger format + `verify` contract |
| `docs/override.md` | Verdict override: `--override` flags, `OVERRIDDEN` receipt line, fail-closed errors |
| `docs/console-v1-design.md` | Console API contract (route table) + views |
| `docs/console-v1b.md` | Org-wide topology/org-state flags |
| `docs/rulepack-v1.2.md` | Current rule pack (21 rules) + deliberately-excluded rule |
| `docs/vision-software-verification-platform.md` | Platform vision |
| `docs/roadmap-S0-S10.md` | S0–S10 roadmap (org policies at S5) |
| `docs/cloudflare.md` | Cloudflare hosting path |
| `docs/ARCHITECTURE.md` | Module map, data flows, test map, extension guide |

## CLI quickstart

```
npm install -g @aftergraph/sentinel   # Node >= 20, no build step
sentinel review --pr 42               # [VERIFY]/manual — needs gh auth + network; exit 0 SHIP / 1 DO NOT SHIP / 2 STALE
sentinel review --pr 42 --format json # Review + Verdict + Findings per docs/data-model-v0.md
sentinel review --pr 42 --format sarif > results.sarif
sentinel review --pr 42 --format gov > gov.json   # ci-result-shaped verdict (docs/receipts-v0.1.md)
sentinel review --pr 42 --rule-pack 1.0.0  # pinned 6-rule pack (1.1.0: 20 rules, 1.2.0: 21, 1.3.0: 22, 1.4.0: 23, 1.5.0: 24, default)
sentinel verify --receipt ./receipt.json   # offline VALID/INVALID check
git diff | sentinel review --diff - --repo myorg/myrepo  # local mode, no GitHub needed
git diff | sentinel review --diff - --repo myorg/myrepo --policy policies/web-default.yaml  # policy-gated (docs/policy.md)
git diff | sentinel review --diff - --repo myorg/myrepo --override DO_NOT_SHIP --override-reason incident-123 --override-actor alice  # break-glass override, fail-closed (docs/override.md)
sentinel verify run --finding <ruleId:file:line> --repo-dir . --commands ./commands.json  # isolated verify run (docs/pipeline.md)
sentinel resolve --rule-id <id> --file <path> --reason <text>  # silence a finding (memory)
sentinel --help                       # every flag documented; output matches this file
```

Every review appends a content-addressed receipt to `~/.sentinel/ledger.jsonl`
(`docs/receipts-v0.1.md`) — re-running the same HEAD yields the same receipt id.

Full suite: `npm test` — 456 tests green, 0 fail (rule packs: 1.0.0 = 6 rules,
1.1.0 = 20, 1.2.0 = 21, 1.3.0 = 22, 1.4.0 = 23, 1.5.0 = 24 per `lib/rulepack.js`).

Beyond the CLI: `sentinel-mcp` (read-only MCP judge for coding-agent loops,
`docs/mcp.md`), policy-gated review (`review --policy`, `docs/policy.md`),
isolated verify runs (`verify run`, `docs/pipeline.md`),
`apps/github` (S1 webhook → verdict card [VERIFY]/manual — needs App install
+ webhook delivery; tests mocked — plus check-runs transport via `gh api`
[VERIFY]/manual, see `apps/github/README.md`; webhook HTTP handler
`createHandler` (`apps/github/app.js`: timing-safe HMAC over the raw body,
1 MB cap) pre-existed — NO-BUILD, no duplicate entry point, 10 gap tests in
`test/github-webhook.test.mjs`), and the platform vision
(`docs/vision-software-verification-platform.md`,
`docs/roadmap-S0-S10.md`, Cloudflare hosting in `docs/cloudflare.md`).

## Console (local web UI, PWA-ready)

```
node bin/sentinel.js serve --port 8787
# open http://127.0.0.1:8787 in a browser
node bin/sentinel.js serve --topology platform-topology.json --org-state latest-org-state.json  # org-wide rows (docs/console-v1b.md)
node bin/sentinel.js serve --evidence-store ./evidence.json  # persist sealed verify-run evidence (docs/pipeline.md)
node bin/sentinel.js serve --org-store ./orgs.json        # org scoping for /api/orgs* + ?org= (docs/console-v1-design.md §4)
```

Board, run, rules, config, ledger views over the same verdict engine —
what the UI shows is byte-identical to the CLI (`docs/console-v1-design.md`).
Binds 127.0.0.1 by default; remote bind requires `--token` or
`SENTINEL_CONSOLE_TOKEN`. `--org-store` fails closed at boot on a missing
file — stderr `Error: cannot read org store file: <path>`, exit 1, no
socket listens (observed live; contract: `test/cli-orgstore.test.mjs`).
`bin/sentinel.js --help` lists both `--evidence-store <p>` and
`--org-store <p>` on the `serve` usage line; output matches this file.

CI gate (GitHub Actions — gate on exit code: 0 pass, 1 fail, 2 re-run, never treat 2 as failure):

```yaml
- run: sentinel review --pr ${{ github.event.pull_request.number }} --format json
```

## Recommended next execution

Prototype sprint: verdict-card mock + CLI output contract against 5 real PRs (manual runs, no automation). Then landing page/waitlist draft. Interviews/pilot are **optional later** — not active next actions.
