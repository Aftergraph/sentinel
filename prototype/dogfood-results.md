# Dogfood Results — Sentinel 6-Rule Pack vs 5pr-validation.md

Branch: `prototype/dogfood-results` (from `origin/main` @ c946d46)
CLI: `node bin/sentinel.js review --pr <N> --repo Aftergraph/studio`
Rule pack (6 rules): no-unauthenticated-api-endpoints, no-secrets-in-cicd-config,
require-transaction-rollback-on-failure, no-unindexed-schema-migration-on-large-tables,
no-n-plus-one-queries-in-api-resolvers, require-dataloader-or-eager-load-for-nested-fetches.

---

## Per-PR Results

| PR | Expected | Actual | Exit | Findings | Match |
|----|----------|--------|------|----------|-------|
| #41 | SHIP | SHIP | 0 | 0 | ✅ MATCH |
| #22 | DO NOT SHIP | SHIP | 0 | 0 | ❌ MISS |
| #36 | DO NOT SHIP | SHIP | 0 | 0 | ❌ MISS |
| #34 | STALE | SHIP | 0 | 0 | ❌ MISS |
| #4  | SHIP | SHIP | 0 | 0 | ✅ MATCH |

**Aggregate score: 2/5**

---

## Detailed findings per PR

### PR #41 — style(p1-001): map muted text family to text-3 token
- **Expected:** SHIP (clean CSS token consolidation)
- **Actual:** SHIP — 0 findings, exit 0
- **Verdict:** MATCH
- No rule in the 6-pack flags CSS-only changes; expected SHIP and got SHIP.

### PR #22 — fix(server): stop hubs and drain persists on close
- **Expected:** DO NOT SHIP (swallowed exceptions at server/app-server.mjs:708-712)
- **Actual:** SHIP — 0 findings, exit 0
- **Verdict:** MISS
- **Root cause:** The expected finding (`no-swallowed-exceptions-in-critical-path`) is rule-gap-list #7, which is explicitly listed as a v1 gap and is not among the 6 implemented rules. The current rule pack has no detector for empty catch blocks or silent exception swallowing, so the CLI correctly reports zero findings against its own rule set even though the human reviewer flagged a real defect.

### PR #36 — feat(auth): operator user-invite form with grantable capability directory
- **Expected:** DO NOT SHIP (trust-boundary gap: client-side capability rendering without server re-assertion proof in diff; missing CSRF token binding)
- **Actual:** SHIP — 0 findings, exit 0
- **Verdict:** MISS
- **Root cause:** The expected finding requires cross-file correlation between UI form code (`packages/ui/trust/user-invite.mjs`) and the server handler (`src/api-routes.mjs` / `src/auth/ui-actions.mjs`) to detect that the diff adds a route but no inline server-side validation. The 6-pack's `no-unauthenticated-api-endpoints` rule operates on single-file diff patterns and cannot correlate that a new route entry lacks a corresponding guard in a separate file. Additionally, CSRF/token-binding detection is not in the rule pack at all.

### PR #34 — feat(auth): per-IP rate limit on magic-link issuance
- **Expected:** STALE (base moved mid-review due to PR #33 merge; exit code 2)
- **Actual:** SHIP — 0 findings, exit 0
- **Verdict:** MISS
- **Root cause:** Staleness detection in `lib/review.js:146-151` compares `base.sha` before and after the rule-check pass within a single CLI invocation. For PR #34, the base did not move during this particular run (the PR was reviewed long after PR #33 merged and the base settled), so the staleness check correctly found no drift. The expected STALE verdict was recorded during the original manual review when the base was actively moving; replaying the CLI now produces SHIP because the condition is transient and no longer present.

### PR #4 — chore(deps): bump ossf/scorecard-action from 2.4.2 to 2.4.4
- **Expected:** SHIP (patch-level Dependabot bump, verified source)
- **Actual:** SHIP — 0 findings, exit 0
- **Verdict:** MATCH
- No rule in the 6-pack flags dependency bumps; expected SHIP and got SHIP.

---

## Summary of MISS root causes

| PR | One-line root cause |
|----|---------------------|
| #22 | Expected `no-swallowed-exceptions-in-critical-path` rule is a documented v1 gap, not in the 6-pack |
| #36 | Expected trust-boundary finding requires cross-file correlation beyond single-file diff rules |
| #34 | STALE is a transient condition; base no longer moves during replay, so CLI correctly returns SHIP |
