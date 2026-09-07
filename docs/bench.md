# SentinelBench — falsifiable rule-pack scoring

Deterministic harness: every case in `bench/cases/*.json` references a
fixture diff plus the exact rule ids that must fire (`expect`). A case
hits **iff** every expected rule fires **and** no unexpected rule fires
(strict). Known true-positive overlaps are encoded with both rules
expected — the runner is never weakened to make a pack pass.

```bash
node bench/report.js [pack]   # writes bench/results.json + bench/REPORT.md (default pack 1.4.0)
node --test test/bench.test.mjs
```

Current score (v1.4.0): **18 cases, recall 1.0, precision 1.0, 0 misses.**

Metrics are pure counts (recall, precision, FP-per-case, rules-fired
distribution). No LLM, no timing, no network. Scores are data: a low
score never breaks the build — `test/bench.test.mjs` pins the *current*
contract instead, so regressions fail loudly while the harness stays
honest about the pack it measures.

## Case format

```json
{ "name": "security-eval",
  "diffFile": "test/fixtures/no-eval-with-dynamic-input/positive.diff",
  "expect": ["no-eval-with-dynamic-input"],
  "severity": "security" }
```

`diffFile` is repo-root-relative (absolute paths accepted) and always
points at an existing `test/fixtures` diff — never a copy. `expect` lists
every rule that must fire, `[]` for clean controls. `severity`/`note` are
documentation only. `"strict": false` + `"reason"` marks a recall-only
case; none ship — the slot exists so a future cross-firing fixture can be
encoded without weakening the runner.

## Coverage (16 cases)

All six severities: security (eval, private-key, + overlap), reliability
(process-exit, lockfile), data (destructive-sql, where-on-delete),
performance (n-plus-one, + overlap), correctness (strict-equality),
style (no-var, console-log). Four clean controls (`expect: []`): eval,
secrets-cicd, strict-equality, sync-io negatives.

## Strictness and the known overlap

Three fixtures cross-fire under the full pack and every firing is correct.
Two per `docs/rulepack-v1.1.md` ("Known true-positive overlap"): a bare
unauthenticated collection route fires `no-unauthenticated-api-endpoints`
and `no-unbounded-list-query-without-pagination`. Third per
`docs/rulepack-v1.2.md`: a migration that drops a column with no backup
reference fires both `no-destructive-sql-without-guard` and
`no-destructive-migration-without-backup-verification`. All overlap cases
expect both rules and stay strict — verified empirically (every other
positive fires exactly its own rule; every negative fires nothing).
