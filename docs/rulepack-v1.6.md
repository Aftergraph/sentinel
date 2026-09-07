# Rule-pack v1.6.0 — Sentinel by Aftergraph

**Status:** implemented. Extends v1.5.0 (24 rules, `docs/rulepack-v1.5.md`)
to 25 rules. v1.0.0 through v1.5.0 remain available via
`sentinel review --rule-pack <version>` — pack versions are pinned in every
verdict, so old verdicts stay reproducible.

## Addition (1)

| # | Rule | Severity | Blocks? | Signal |
|---|------|----------|---------|--------|
| 25 | no-recreate-single-replica-deployment | reliability | yes | Workload manifest ADDS both `replicas: 1` and `type: Recreate` in the same file's added lines |

First deployment-topology rule: the combination is the binary downtime
signal (no replica to absorb the kill, no rolling update to overlap it) —
each setting alone stays out per prior decision (singletons, queues, dev
cost-saving). Escape hatch: either key pre-existing before the diff (not
added by this change). Deliberate precision scoping: commented lines are
not code; dev/staging-named paths skipped; Job/CronJob kinds skipped
(never roll); Helm/charts skipped (values-templated replicas invisible
to a diff regex).

## Verification

- Fixtures: positive (Deployment + replicas:1 + Recreate fires) and
  negative (replicas:3, RollingUpdate, Job kind, dev path, commented
  lines — all silent).
- Bench: pack `1.6.0` scores strict on every shipped case (recall 1,
  precision 1) — the new rule fires on no existing bench case.
- Full suite: `npm test` green.
