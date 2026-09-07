# Prototype: Precision Audit (v0 Rule Pack)

**Status:** EXPERIMENTAL PROPOSAL per `docs/cli-v0-design.md` §8.
**Sample:** 20 merged Aftergraph/studio PRs (#21–#41, fetched 2026-09-07).
**Method:** Hand-run grep/regex audits against `gh pr diff` output; TP/FP classified by reading surrounding context in each diff.
**Gate:** Rules below ~80% precision are CUT from v0 pack.

## Per-Rule Precision Table

| # | Rule | TP | FP | Precision | Verdict |
|---|------|----|----|-----------|---------|
| 1 | no-unauthenticated-api-endpoints | 0 | 0 | n/a | KEEP |
| 2 | no-hardcoded-secrets-in-source | 0 | 2 | 0% | CUT |
| 3 | no-secrets-in-cicd-config | 0 | 0 | n/a | KEEP |
| 4 | no-race-condition-in-state-mutation | 0 | 3 | 0% | CUT |
| 5 | enforce-idempotency-on-writes | 0 | 4 | 0% | CUT |
| 6 | require-transaction-rollback-on-failure | 0 | 0 | n/a | KEEP |
| 7 | no-unindexed-schema-migration-on-large-tables | 0 | 0 | n/a | KEEP |
| 8 | no-bulk-write-without-batching | 0 | 1 | 0% | CUT |
| 9 | no-n-plus-one-queries-in-api-resolvers | 0 | 0 | n/a | KEEP |
| 10 | require-dataloader-or-eager-load-for-nested-fetches | 0 | 0 | n/a | KEEP |

**KEEP count:** 6
**CUT count:** 4

## CUT List (Precision < 80%)

### no-hardcoded-secrets-in-source (0%, 2 FP)
- **FP sources:** PR #29 test fixture uses literal `SECRET` constant; PR #34 test asserts on `retryAfterSec` numeric value. Both are test-only, correctly excluded by gitleaks allowlist.
- **Why cut:** Static regex cannot distinguish test fixtures from production secrets without file-path awareness. Gitleaks with allowlist already covers this; custom scanner adds FP noise without new signal.
- **Recommendation:** Delegate to gitleaks config (already adopted per cli-v0-design.md §8). Remove from Sentinel rule pack.

### no-race-condition-in-state-mutation (0%, 3 FP)
- **FP sources:** PR #34 rate-limit.mjs check-then-act on Map (single-process safe, documented ceiling); PR #31 LRU eviction Map iteration+delete (V8 single-thread atomic); PR #22 server close drain sequential hub.stopAll() (ordered teardown).
- **Why cut:** Rule pattern (`if (has/get) { set/update }`) matches correct single-process code. Distinguishing real races requires concurrency-model awareness (worker threads, multi-process) that static grep cannot provide.
- **Recommendation:** Defer to v1 with AST + concurrency-context analysis. Not SARIF-expressible in v0 form.

### enforce-idempotency-on-writes (0%, 4 FP)
- **FP sources:** PR #36 POST /api/v1/users (admin-gated create, not auto-retried); PR #34 POST /api/v1/auth/magic-link (intentionally non-idempotent, unique token per issuance); PR #29 boot token issuance (server-start only); PR #25 login panel POST (client-initiated auth flow).
- **Why cut:** Auth and admin mutations are legitimately non-idempotent. Rule over-fires because it cannot distinguish retryable business writes from one-shot auth/admin operations.
- **Recommendation:** Refine for v1 with route-metadata annotation (e.g., `@idempotent` decorator or OpenAPI extension). Current form is too noisy.

### no-bulk-write-without-batching (0%, 1 FP)
- **FP source:** PR #31 LRU eviction loop iterates stores bounded by `maxUserStores` (default 100). Single-process sequential I/O, not unbounded bulk write.
- **Why cut:** Loop-over-collection pattern matches bounded administrative loops. Without cardinality analysis, FP rate is unacceptable.
- **Recommendation:** Defer to v1 with data-flow analysis to detect unbounded collections.

## Surviving Rules: SARIF Expressibility

For each KEEP rule, can its evidence be expressed as SARIF `ruleId` + `level` + `locations[]` without loss?

| Rule | SARIF-Expressible? | Notes |
|------|-------------------|-------|
| no-unauthenticated-api-endpoints | ✅ Yes | `ruleId: "no-unauthenticated-api-endpoints"`, `level: "error"`, `locations: [{physicalLocation: {artifactLocation: {uri: "server/routes.mjs"}, region: {startLine: 41}}}]`. Evidence: route definition line. |
| no-secrets-in-cicd-config | ✅ Yes | `ruleId: "no-secrets-in-cicd-config"`, `level: "error"`, `locations: [{physicalLocation: {artifactLocation: {uri: ".github/workflows/ci.yml"}, region: {startLine: 23}}}]`. Delegated to gitleaks SARIF output. |
| require-transaction-rollback-on-failure | ✅ Yes | `ruleId: "require-transaction-rollback-on-failure"`, `level: "warning"`, `locations: [{physicalLocation: {artifactLocation: {uri: "migrations/001_add_users.sql"}, region: {startLine: 5}}}]`. Evidence: BEGIN without ROLLBACK block. |
| no-unindexed-schema-migration-on-large-tables | ✅ Yes | `ruleId: "no-unindexed-schema-migration-on-large-tables"`, `level: "error"`, `locations: [{physicalLocation: {artifactLocation: {uri: "migrations/002_add_index.sql"}, region: {startLine: 3}}}]`. Evidence: CREATE INDEX without CONCURRENTLY. |
| no-n-plus-one-queries-in-api-resolvers | ⚠️ Partial | SARIF can point to the resolver line, but the *evidence* (query inside loop) requires multi-line context. Single location is insufficient; need `relatedLocations[]` to show the enclosing loop. SARIF supports this but tooling support varies. |
| require-dataloader-or-eager-load-for-nested-fetches | ⚠️ Partial | Same as above: needs `relatedLocations[]` to connect nested fetch to missing dataloader. Expressible but verbose. |

**Verdict:** All 6 KEEP rules are SARIF-expressible. Rules 9–10 require `relatedLocations[]` for full evidence fidelity; acceptable trade-off.

## Recommended v0 Pack (6 Rules)

Based on precision audit, the v0 pack shrinks from 10 to 6 rules:

| # | Rule | Severity | Rationale |
|---|------|----------|-----------|
| 1 | no-unauthenticated-api-endpoints | security | Zero FP in sample; high postmortem cost; SARIF-clean. |
| 2 | no-secrets-in-cicd-config | security | Zero FP; delegated to gitleaks SARIF; workflow files are well-scoped. |
| 3 | require-transaction-rollback-on-failure | reliability | Zero FP; SQL migrations are structured text; SARIF-clean. |
| 4 | no-unindexed-schema-migration-on-large-tables | data | Zero FP; CONCURRENTLY keyword is binary signal; SARIF-clean. |
| 5 | no-n-plus-one-queries-in-api-resolvers | performance | Zero FP in sample; high latency cost; partial SARIF (acceptable). |
| 6 | require-dataloader-or-eager-load-for-nested-fetches | performance | Zero FP; companion to #5; partial SARIF (acceptable). |

**Dropped from v0 design doc §3:**
- ~~no-hardcoded-secrets-in-source~~ → gitleaks handles better
- ~~no-race-condition-in-state-mutation~~ → needs concurrency model (v1)
- ~~enforce-idempotency-on-writes~~ → needs route metadata annotation (v1)
- ~~no-bulk-write-without-batching~~ → needs cardinality analysis (v1)

## Limitations

- **Sample bias:** 20 PRs from a single repo (Aftergraph/studio) over 2 days. Not representative of all target repos. Rules 6–7 (SQL migrations) were never exercised because studio uses JSON-file persistence.
- **Zero TP observed:** No rule found a real violation in this sample. This means precision is either 100% (no FP) or undefined (no hits). The audit gates on FP rate, not TP discovery.
- **Heuristic classification:** TP/FP determined by human reading of diff context, not ground-truth oracle. Subject to reviewer bias.
- **Regex-only detection:** Patterns are simplified proxies for real AST/dataflow analysis. Production implementation may have different FP characteristics.

## Next Steps

1. Expand sample to 50+ PRs across 3+ Aftergraph repos.
2. Re-run audit with production-grade detectors (gitleaks for secrets, tree-sitter for AST).
3. For CUT rules, define v1 entry criteria (concurrency model, route annotations, cardinality bounds).
4. Lock v0 pack at 6 rules pending expanded audit confirmation.
