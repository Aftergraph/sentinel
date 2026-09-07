# SentinelBench — falsifiable rule-pack scoring

Deterministic harness: every case in `bench/cases/*.json` references a
fixture diff plus the exact rule ids that must fire (`expect`). A case
hits **iff** every expected rule fires **and** no unexpected rule fires
(strict). Known true-positive overlaps are encoded with both rules
expected — the runner is never weakened to make a pack pass.

```bash
node bench/report.js [pack]   # writes bench/results.json + bench/REPORT.md (default pack 1.6.0)
node --test test/bench.test.mjs
```

Current score (v1.7.0): **26 cases, recall 1.0, precision 1.0, 0 misses** (+ 2 held-out, excluded).

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
case; `"heldout": true` marks a held-out case that is evaluated
but EXCLUDED from the main score and rendered under
`## Held-out (excluded from score)` (advisory only — held-out
results never enter recall/precision/FP-per-case or any verdict); two ship:
`security-eval-l4-positive` (positive) and `clean-structured-clone-negative`
(clean control), both L4 additions, so the newest cases prove the pack instead
of padding its score.

## Coverage (28 cases: 26 scored + 2 held-out)

All six severities: security (eval, private-key, + overlap), reliability
(process-exit, lockfile, health-check, recreate-single-replica,
retry-backoff), data (destructive-sql, where-on-delete, foreign-key),
performance (n-plus-one, + overlap), correctness (strict-equality),
style (no-var, console-log). Four clean controls (`expect: []`): eval,
secrets-cicd, strict-equality, sync-io negatives, plus
two L4 controls (`clean-optional-chaining-negative`: `?.`/`??`/
`Array.at`/`Object.hasOwn`; `clean-structured-clone-negative`:
`structuredClone`/`Object.entries`/`fromEntries`) and two L4
positives (`security-eval-l4-positive` fires only
`no-eval-with-dynamic-input`; `style-no-var-l4-positive` fires only
`no-var-instead-of-let-const`), plus two FP-trap controls pinning rule
fixes (`clean-findings-prop-negative`: loop + `.findings` property is
data, not a query; `clean-params-get-negative`: `params.get()` is
inbound data, not a nested fetch) and one more positive
(`performance-map-query`: `.map` + `.find(` fires only
`no-n-plus-one-queries-in-api-resolvers`;
`performance-map-query-singleline`: same bug on one line — the window
includes the opener's own line).

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
