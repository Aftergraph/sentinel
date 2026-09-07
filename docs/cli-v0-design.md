# CLI v0 Product Design — Sentinel by Aftergraph

**Wedge guardrail:** Sentinel turns pull requests into merge-ready verdicts. First wedge: CLI review on exact HEAD → SHIP / DO NOT SHIP verdict with cited evidence → GitHub App.

Status: design (no code). Locks the v0 command contract, rule-pack, and storage before scaffolding.

## 1. Command contract

```
$ sentinel review --pr 42 [--repo owner/name] [--format human|json] [--rule-pack 1.0.0]
HEAD <sha> (verified: base main@<sha> unchanged since review start)

DO NOT SHIP — 2 findings
1. [security] Unauthenticated DELETE route — routes/admin.mjs:41
   Rule: no-unauthenticated-api-endpoints. Evidence: no auth middleware on DELETE /admin/purge.
...

4 checks passed: secrets-scan, lockfile-consistency, test-status, diff-size.
```

- `--repo` defaults to `origin` remote of cwd. `--format json` emits the Review + Verdict + Finding records per `docs/data-model-v0.md` (machine surface for CI gates).
- Auth: read-only GitHub token (`gh auth` env reuse first, `GITHUB_TOKEN` fallback). CLI never writes to the repo, PR, or checks — verdict goes to stdout only.

## 2. Exit codes (contract, never silently changed)

| Code | Meaning |
|---|---|
| 0 | SHIP — verified HEAD, no blocking findings |
| 1 | DO NOT SHIP — verified HEAD, ≥1 blocking finding |
| 2 | STALE — base moved mid-review; no verdict issued |

Exit 2 is distinct from findings by design: CI gates must treat STALE as re-run, never as failure.

## 3. Rule-pack v0 (`sentinel-rules@1.0.0`, 6 rules)

Final pack per `prototype/precision-audit.md` (20 PRs, cut below ~80% precision). CUT from the original 10: no-hardcoded-secrets-in-source (delegated to gitleaks, §8), no-race-condition-in-state-mutation, enforce-idempotency-on-writes, no-bulk-write-without-batching (all with documented FPs; race/idempotency deferred to v1 with AST analysis).

| # | Rule | Severity | Detects on |
|---|---|---|---|
| 1 | no-unauthenticated-api-endpoints | security | route table vs auth middleware (JS/TS) |
| 2 | no-secrets-in-cicd-config | security | workflow files in diff |
| 3 | require-transaction-rollback-on-failure | reliability | migration files without DOWN/rollback block |
| 4 | no-unindexed-schema-migration-on-large-tables | data | migrations adding index/column without CONCURRENTLY |
| 5 | no-n-plus-one-queries-in-api-resolvers | performance | resolvers querying inside result loops |
| 6 | require-dataloader-or-eager-load-for-nested-fetches | performance | nested-fetch without batching (companion to 5) |

Rule-pack is versioned and org-owned; a verdict always names its pack version. Implemented in `lib/rules/` as pure functions with positive+negative fixtures each (`test/fixtures/`, 12/12 green).

## 4. Resolution memory

- Store: local append-only JSONL at `~/.sentinel/resolutions.jsonl` (one record per resolved finding: ruleId + file + line-fingerprint + resolvingHeadSha). No server, no account — CLI runs as the invoking engineer (data-model-v0 non-entities).
- On each run, findings matching a resolution record for the same file+rule are reported as `resolved (not re-reported)` and excluded from the blocking count. Resolved findings never flip a verdict on the same HEAD.
- New HEAD = new Review; memory carries across reviews so fixed findings stay silent.

## 5. CI usage (v0 target)

```yaml
- run: sentinel review --pr ${{ github.event.pull_request.number }} --format json
```

Gate on exit code: 0 pass, 1 fail, 2 re-run. Dogfood target: every Aftergraph studio PR gets a verdict; exit criterion 10 repos running CLI in CI weekly.

## 6. Non-goals (v0)

No auto-fix, no auto-approve, no PR comments (GitHub App phase), no dashboard, no User table, no server component. Style-severity findings are reported but never block.

## 8. Standards alignment (draft — pending owner acceptance)

Prior-art decisions per FIN lifecycle (working-draft maturity, no higher claim):

- **Findings output → ADOPT SARIF.** Static Analysis Results Interchange Format (OASIS standard, GitHub code-scanning native) replaces the custom Finding JSON for the machine surface. `--format sarif` emits standard `runs[].results[]` with `ruleId`, `level`, and `locations[]` (file:line). The SHIP/STALE verdict envelope has no prior art and stays NEW INTERNAL: a minimal `{ verdict, headSha, baseSha, rulePackVersion }` wrapper around the SARIF run. Rationale: two teams reach the same result; GitHub SARIF upload becomes a free App-phase integration.
- **Secrets rules (pack #2–3) → ADOPT gitleaks config.** No custom entropy scanner in v0; ship a pinned gitleaks config + version as the pack's secrets provider. Custom detection is rejected as duplicate prior art.
- **Exit codes → PROFILED de-facto CI convention.** 0 pass / nonzero fail is ADOPTED universal CI behavior. Code 2 for STALE is a documented EXTENSION: CI must map it to re-run, never to failure. `sysexits.h` (EX_TEMPFAIL=75) considered and rejected — 75 breaks the `exit==0||retry` muscle memory every CI author has; 2 is the smallest deviation that survives contact with real pipelines. `// ponytail: exit 2, not EX_TEMPFAIL — re-run convention beats stdlib purity here.`
- **Precision audit (recommendation step 1) → EXPERIMENTAL PROPOSAL.** Bounded hypothesis test (20 PRs, per-rule precision table), not a compatibility promise. If precision <80% for a rule, the rule is cut — the experiment gates the pack, it does not negotiate with it.
- **Verdict determinism (recommendation step 2) → NEW INTERNAL, proposed locked.** v0 verdict path is pure functions of (diff, rule-pack): same diff + same pack = same verdict, byte-identical. No LLM in the verdict path; LLM allowed in v1 as explanation layer only. Pending owner lock in `decisions.md`.

Maturity: working draft. Missing for candidate: reference implementation, review window, conformance recipe (F-03 fixtures are the start of one).

## 7. Acceptance for v0 slice

- `sentinel review --pr <n>` runs against 5 real Aftergraph PRs reproducing `prototype/5pr-validation.md` verdicts (4/5 match minimum).
- STALE path proven by a mid-review base move (exit 2, no verdict).
- Resolution memory proven: fix a finding, re-run same HEAD, finding stays silent.
- LF-only, Node single-runtime, `npm install -g` ≤5 min path documented.
