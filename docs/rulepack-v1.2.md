# Rule-pack v1.2.0 — Sentinel by Aftergraph

**Status:** implemented. Extends v1.1.0 (20 rules, `docs/rulepack-v1.1.md`)
to 21 rules. v1.0.0 and v1.1.0 remain available via
`sentinel review --rule-pack <version>` — pack versions are pinned in every
verdict, so old verdicts stay reproducible.

## Addition (1)

| # | Rule | Severity | Blocks? | Signal |
|---|------|----------|---------|--------|
| 21 | no-destructive-migration-without-backup-verification | data | yes | `DROP TABLE/COLUMN`, `TRUNCATE` in migration SQL (`migrations?/db/schema` paths) with no backup reference (`backup`, `pg_dump`, `snapshot`, `restore drill`, `runbook`) in the same file's added lines |

Upstream rule merged from main (PR #2); it matches precision-audit gap #13
(verified: SQL-path scoped, destructive keyword, backup-reference escape
hatch). Same design constraints as v1.1.0 apply: pure function of the
unified diff, binary-signal keyword, narrow file scope.

## Deliberately NOT in any pack

`no-swallowed-exceptions-in-critical-path` ships in-tree (rule module +
positive/negative fixtures, covered by `test/rules.test.mjs`) but is
excluded from all packs. Rationale: the name promises critical-path
scoping the regex cannot deliver — it fires on every empty `catch {}`
in any JS/TS file (precision-audit CUT gap #7). Promote it only with
real path-criticality context (call-graph or route awareness).

## Verification

- 44/44 rule fixture tests green (22 modules × positive + negative).
- Bench: `node bench/report.js` — 16 cases, recall 1.0, precision 1.0,
  0 misses on pack 1.2.0 (see `docs/bench.md`).
- Full suite: `npm test` green.
