# Historical Dogfood Results — Sentinel 6-Rule Pack vs 5pr-validation.md

> **Evidence boundary:** this is a real CLI replay of the original **six-rule** pack at an older Sentinel version. It is preserved as historical evidence and failure analysis. The current rule-pack source of truth is `lib/rulepack.js` (v1.7.0 / 26 rules at the 2026-09-08 evidence cut). **Do not quote 2/5 as current Sentinel accuracy.** See `docs/evidence-status.md`.

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

**Historical six-rule replay score: 2/5.**

This score answers only: “Did that six-rule implementation reproduce the five historical expected labels when replayed later?” It does not measure current-pack precision/recall, and the STALE case is inherently transient.

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
- **Root cause:** The expected finding (`no-swallowed-exceptions-in-critical-path`) is rule-gap-list #7 and was not among the six implemented rules. The replay therefore exposed a recall gap relative to the manual baseline.

### PR #36 — feat(auth): operator user-invite form with grantable capability directory
- **Expected:** DO NOT SHIP (trust-boundary gap: client-side capability rendering without server re-assertion proof in diff; missing CSRF token binding)
- **Actual:** SHIP — 0 findings, exit 0
- **Verdict:** MISS
- **Root cause:** The expected finding requires cross-file correlation between UI form code and the server handler. The six-rule `no-unauthenticated-api-endpoints` detector operates on narrow diff patterns and could not establish that absence across files. CSRF/token-binding detection was not present either.

### PR #34 — feat(auth): per-IP rate limit on magic-link issuance
- **Expected:** STALE (base moved during the original manual review; exit code 2)
- **Actual:** SHIP — 0 findings, exit 0
- **Verdict:** MISS for historical-label replay, **not evidence that the staleness detector failed**.
- **Root cause:** Staleness is a live temporal condition. `lib/review.js` samples base state within a review invocation. During this later replay the base no longer moved, so a static rerun could not reproduce the original transient condition. Use a controlled base-move live-fire test for STALE evidence.

### PR #4 — chore(deps): bump ossf/scorecard-action from 2.4.2 to 2.4.4
- **Expected:** SHIP
- **Actual:** SHIP — 0 findings, exit 0
- **Verdict:** MATCH

---

## What this artifact established

1. The original six-rule CLI executed against real GitHub PRs.
2. Two historical expected labels matched directly.
3. Two misses corresponded to capabilities not represented by that pack.
4. The STALE historical label cannot be treated as a deterministic static replay fixture.
5. Expanding a rule count is not itself evidence that these misses are now fixed.

## Required successor

Run the same evaluation protocol against the current v1.7.0 pack and record exact Sentinel HEAD, target PR HEAD/base, command, exit code, receipt id and findings. For STALE, use a controlled live base-move scenario or mark it `NOT_REPRODUCED`.
