# Rule-pack v1.4.0 — Sentinel by Aftergraph

**Status:** implemented. Extends v1.3.0 (22 rules, `docs/rulepack-v1.3.md`)
to 23 rules. v1.0.0 through v1.3.0 remain available via
`sentinel review --rule-pack <version>` — pack versions are pinned in every
verdict, so old verdicts stay reproducible.

## Addition (1)

| # | Rule | Severity | Blocks? | Signal |
|---|------|----------|---------|--------|
| 23 | require-health-check-before-traffic-shift | reliability | yes | `*.yaml` (non-test, non-template/chart/values/compose/workflow) adds a container `image:` with no `readinessProbe:`/`livenessProbe:` in the same file's added lines; a `kind: Job/CronJob` in the added lines opts out (never takes traffic) |

Lockfile-shaped same-diff check: probes declared in the same change are
the escape hatch. Promotes precision-audit gap #10 — the v1.3.0 "no
presence-signal formulation" verdict is superseded: same-file added-lines
scoping gives the absence check a binary, file-local signal. Same design
constraints as v1.1.0 apply: pure function of the unified diff,
binary-signal keyword, narrow file scope.

## Deliberately NOT in any pack

Unchanged from v1.3.0 except gap #10's promotion above:
`no-swallowed-exceptions-in-critical-path` (CUT gap #7),
`no-single-point-of-failure-in-deployment` (#9 — `replicas: 1` and
`strategy: Recreate` have wide legitimate use, no binary signal without
replica-topology context), and the schema-context gaps #12/#14/#19.
Entry criteria: topology-aware or schema-aware checks. Shipping them as
regexes would trade precision for rule count — precision is the moat.

## Verification

- 48/48 rule fixture tests green (24 modules × positive + negative).
- Bench: `node bench/report.js` — 18 cases, recall 1.0, precision 1.0,
  0 misses on pack 1.4.0 (see `docs/bench.md`).
- Full suite: `npm test` green.
