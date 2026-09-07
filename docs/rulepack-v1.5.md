# Rule-pack v1.5.0 — Sentinel by Aftergraph

**Status:** implemented. Extends v1.4.0 (23 rules, `docs/rulepack-v1.4.md`)
to 24 rules. v1.0.0 through v1.4.0 remain available via
`sentinel review --rule-pack <version>` — pack versions are pinned in every
verdict, so old verdicts stay reproducible.

## Addition (1)

| # | Rule | Severity | Blocks? | Signal |
|---|------|----------|---------|--------|
| 24 | require-foreign-key-constraints-on-related-tables | data | yes | Migration/schema SQL adds a `*_id` column of reference type (INT/INTEGER/BIGINT/SMALLINT/NUMERIC/UUID) with no `REFERENCES`/`FOREIGN KEY` in the same file's added lines |

First schema-aware rule: same-file added-lines scoping gives the
absence check a binary, file-local signal (the v1.3.0 entry criterion
for gap #14, met). Escape hatch: any `REFERENCES`/`FOREIGN KEY` in the
file's added lines silences the file. Deliberate precision scoping:
commented lines are not code; files adding a `*_type` column are skipped
(polymorphic associations legitimately carry no FK); bare `id` never
matches (surrogate primary keys are not references). Same design
constraints as v1.1.0 apply: pure function of the unified diff,
binary-signal keyword, narrow file scope.

## Deliberately NOT in any pack

Unchanged from v1.4.0 except gap #14's promotion above:
`no-swallowed-exceptions-in-critical-path` (CUT gap #7),
`no-single-point-of-failure-in-deployment` (#9),
`require-backward-compatible-schema-changes` (#12), and
`require-index-for-where-clause-columns` (#19). Entry criteria:
topology-aware or deploy-model-aware checks. Shipping them as regexes
would trade precision for rule count — precision is the moat.

## Verification

- 50/50 rule fixture tests green (25 modules × positive + negative).
- Bench: `node bench/report.js` — 19 cases, recall 1.0, precision 1.0,
  0 misses on pack 1.5.0 (see `docs/bench.md`).
- Full suite: `npm test` green.
