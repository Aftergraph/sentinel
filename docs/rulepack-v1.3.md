# Rule-pack v1.3.0 — Sentinel by Aftergraph

**Status:** implemented. Extends v1.2.0 (21 rules, `docs/rulepack-v1.2.md`)
to 22 rules. v1.0.0, v1.1.0, and v1.2.0 remain available via
`sentinel review --rule-pack <version>` — pack versions are pinned in every
verdict, so old verdicts stay reproducible.

## Addition (1)

| # | Rule | Severity | Blocks? | Signal |
|---|------|----------|---------|--------|
| 22 | require-retry-with-backoff-for-transient-failures | reliability | yes | Single-line `.catch()` whose callback re-invokes the failed call (`fetch`, `axios.*`, `retry*`, `reconnect*`, `run`, `main`, `connect`) with no delay primitive on the line; `bin/` entrypoints and test/spec/fixture files out of scope |

Escape hatch: any delay token on the same line (`setTimeout`,
`setInterval`, `sleep`, `delay`, `backoff`, `retryAfter`, ...) silences
the finding — same shape as the v1.2.0 migration backup-reference hatch.
Fallback values (`.catch(() => ({}))`) never match (no re-invocation
call). Matches precision-audit gap #8. Same design constraints as v1.1.0
apply: pure function of the unified diff, binary-signal keyword, narrow
file scope.

## Deliberately NOT in any pack

`no-swallowed-exceptions-in-critical-path` ships in-tree (rule module +
positive/negative fixtures, covered by `test/rules.test.mjs`) but is
excluded from all packs. Rationale: the name promises critical-path
scoping the regex cannot deliver — it fires on every empty `catch {}`
in any JS/TS file (precision-audit CUT gap #7). Promote it only with
real path-criticality context (call-graph or route awareness).

Also excluded (gap-list rules with no presence-signal formulation —
see `lib/rulepack.js` header):

- `no-single-point-of-failure-in-deployment` (#9) and
  `require-health-check-before-traffic-shift` (#10) are absence checks
  (missing canary strategy / missing readiness probe) a diff regex
  cannot prove without manifest awareness.
- `require-backward-compatible-schema-changes` (#12),
  `require-foreign-key-constraints-on-related-tables` (#14), and
  `require-index-for-where-clause-columns` (#19) need schema/ORM
  context no textual diff rule can deliver at ≥80% precision.

Entry criteria for all five: manifest-aware (k8s/Dockerfile) or
schema-aware checks. Shipping them as regexes would trade precision
for rule count — precision is the moat.

## Verification

- 46/46 rule fixture tests green (23 modules × positive + negative).
- Bench: `node bench/report.js` — 17 cases, recall 1.0, precision 1.0,
  0 misses on pack 1.3.0 (see `docs/bench.md`).
- Full suite: `npm test` green.
