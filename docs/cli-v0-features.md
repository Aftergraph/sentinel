# CLI v0 Features — Sentinel by Aftergraph

Companion to `docs/cli-v0-design.md` (contract) — this file defines WHAT the CLI does, one feature at a time. Each feature ships only when its acceptance holds. v0 = F-01…F-08. Everything else is explicitly v1+.

## F-01 — Review a PR on exact HEAD

Run `sentinel review --pr <n>` (optional `--repo`, defaults to cwd origin). CLI pins HEAD + base SHA at start, fetches the diff read-only via GitHub API, and holds the verdict until completion. If HEAD moves mid-run, the run aborts to STALE instead of judging a commit nobody will merge.

Acceptance: verdict header always names the exact HEAD SHA it verified; a push mid-review yields exit 2, never a verdict.

## F-02 — SHIP / DO NOT SHIP verdict

Single verdict per run, printed first, no hedging language. SHIP = no blocking findings on the verified HEAD. DO NOT SHIP = ≥1 blocking finding, each listed with severity, rule id, file:line, and one-line evidence.

Acceptance: reproduces `prototype/5pr-validation.md` outcomes on the same 5 PRs (4/5 minimum).

## F-03 — 10-rule static check pack

Runs `sentinel-rules@1.0.0` (§3 of the design doc): unauth endpoints, hardcoded secrets, CI-config secrets, race conditions, idempotency, migration rollback, concurrent indexBohemia, bulk batching, N+1, dataloader. Each check reports pass/fail with file:line evidence; style-severity observations are shown but never block.

Acceptance: each rule has a positive + negative fixture (a diff that trips it, a diff that passes).

## F-04 — STALE on base move

Watches base SHA during the run. On move: print `STALE — base moved <old>→<new>, no verdict issued`, exit 2. A stale review can never become a verdict (data-model-v0 invariant).

Acceptance: proven live by merging base mid-review; exit 2 observed, zero findings printed.

## F-05 — Resolution memory

Remembers findings the engineer resolved (`~/.sentinel/resolutions.jsonl`, append-only, local). Resolved findings are shown as silenced, never re-reported, never counted toward the verdict — across runs and across HEADs for the same file+rule.

Acceptance: resolve a finding, re-run, verdict flips to SHIP with the finding listed as silenced.

## F-06 — Machine output for CI gates

`--format json` emits Review + Verdict + Finding records exactly per `docs/data-model-v0.md`. CI gates branch on exit code alone (0 pass / 1 fail / 2 re-run); the JSON is for dashboards and audit trails.

Acceptance: JSON validates against the v0 schema; a gate snippet for GitHub Actions ships in the README.

## F-07 — Read-only by construction

CLI holds a read-only GitHub token and performs zero writes: no PR comments, no check runs, no status updates, no commits. Verdicts go to stdout only. (Writes arrive with the GitHub App phase, never in v0.)

Acceptance: a run proxied through an HTTP recorder shows zero POST/PUT/PATCH to api.github.com.

## F-08 — Five-minute install

`npm install -g @aftergraph/sentinel` on Node LTS with no build step, no native deps, no config file required for first run (`gh auth` token reuse). `sentinel review --help` documents every flag with an example.

Acceptance: clean-machine install → first verdict in ≤5 minutes, timed.

## Explicitly NOT v0 (v1+)

Auto-fix, auto-approve, PR comments / check runs, hosted verdict history, team rule-pack editor, SSO, GitLab/Bitbucket, SARIF output, watch mode, monorepo-aware scoping. Each rejected for the same reason: unverified action or surface destroys trust faster than a missing feature (decisions.md #4).
