# Rule-pack v1.1.0 — Sentinel by Aftergraph

**Status:** implemented. Extends the precision-audited v1.0.0 6-rule pack
(`docs/cli-v0-design.md` §3) to 20 rules. v1.0.0 remains available via
`sentinel review --rule-pack 1.0.0` — pack versions are pinned in every
verdict, so old verdicts stay reproducible.

## Design constraints (from `prototype/precision-audit.md` CUT lessons)

Every v1.1.0 addition is a **pure function of the unified diff** with a
binary-signal keyword scoped to narrow file types. Excluded by design:

- absence checks (missing retry, missing FK, missing health check) — unverifiable from a diff without whole-repo context;
- concurrency-model checks (race conditions) — needs execution-model awareness, deferred to v1 with AST;
- generic secret scanners — delegated to gitleaks per cli-v0-design §8. Only `no-private-key-in-diff` (PEM header, near-zero FP) ships here.

## Additions (14)

| # | Rule | Severity | Blocks? | Signal |
|---|------|----------|---------|--------|
| 7 | no-eval-with-dynamic-input | security | yes | `eval(` / `new Function(` in non-test JS/TS (comment lines excluded) |
| 8 | no-disabled-tls-verification | security | yes | `NODE_TLS_REJECT_UNAUTHORIZED=0`, `rejectUnauthorized: false`, `strictSSL: false` |
| 9 | no-private-key-in-diff | security | yes | `-----BEGIN … PRIVATE KEY-----` in any file |
| 10 | no-unpinned-github-action-ref | security | yes | `uses: …@v4/@main/@latest` in workflow files; 40-hex SHAs pass |
| 11 | no-process-exit-in-server-code | reliability | yes | `process.exit(` in non-test JS/TS (`exitCode=` does not fire) |
| 12 | no-hardcoded-localhost-url-in-diff | reliability | yes | `http://localhost` / `http://127.0.0.1` outside comments and tests |
| 13 | require-lockfile-update-with-manifest-change | reliability | yes | `package.json` changed with no lockfile in the same diff (multi-file rule) |
| 14 | no-destructive-sql-without-guard | data | yes | `DROP TABLE/COLUMN`, `TRUNCATE` in migration SQL |
| 15 | require-where-on-delete-update | data | yes | `DELETE FROM` / `UPDATE…SET` with no `WHERE` on the line or next 3 added lines |
| 16 | no-unbounded-list-query-without-pagination | performance | yes | collection route (`/list`, `/search`, `/items`, plural) with no pagination keyword in the file hunk |
| 17 | no-sync-io-in-route-handler | performance | yes | `fs.*Sync` / `execSync` / `spawnSync` scoped to route/server/handler/controller/resolver/api files only (scripts/ out of scope) |
| 18 | require-strict-equality | correctness | yes | `==` / `!=` in non-test JS/TS; `== null` idiom explicitly allowed |
| 19 | no-var-instead-of-let-const | style | **no** | `var <name>` in non-test JS/TS |
| 20 | no-console-log-in-server-diff | style | **no** | `console.log(` in non-test JS/TS (`console.error/warn` stay allowed) |

Style-severity findings print under `Advisory (non-blocking)` and map to
SARIF `level: note`; they never flip a verdict (cli-v0-design §6).

## Verification

- 40/40 rule fixture tests green (positive + negative per rule).
- 20 negatives are composable: no rule fires on any other rule's negative fixture (cross-FP scan clean).
- Known true-positive overlap: a bare unauthenticated collection route fires both `no-unauthenticated-api-endpoints` and `no-unbounded-list-query-without-pagination` — both findings are correct.
- Full suite: `npm test` → 57 pass (`rules` + `memory-sarif` + `exact-head` + `cli-contract`).
