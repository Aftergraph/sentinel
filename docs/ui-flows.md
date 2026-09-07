# UI flows — Sentinel by Aftergraph

**Wedge guardrail:** Sentinel turns pull requests into merge-ready verdicts. First wedge: CLI review on exact HEAD → SHIP / DO NOT SHIP verdict with cited evidence → GitHub App.

## Flow 1: CLI review (phase B, first)

```
$ sentinel review --pr 42
HEAD a3f9c1d (verified: base main@9be201c unchanged since review start)

DO NOT SHIP — 2 findings
1. [security] Unauthenticated DELETE route — routes/admin.mjs:41
   Rule: auth-required-routes. Evidence: no auth middleware on DELETE /admin/purge.
2. [reliability] Migration without rollback — db/migrate_014.sql
   Rule: migration-rollback-required. Evidence: no DOWN block.

4 checks passed: secrets-scan, lockfile-consistency, test-status(ci#8812 green), diff-size(312 lines).
```

States: `VERIFYING…` (live HEAD pinning) → verdict → `STALE` if base moves (exit code 2, distinct from findings).

## Flow 2: PR comment (phase A, GitHub App)

Verdict card as the only top-level comment (updated in place, never appended):
- Header: verdict pill + HEAD SHA + rule-pack version.
- Findings: max 5 inline comments, each file:line anchored; older ones resolved, never duplicated.
- Footer: "Rebased? Verdict auto-invalidated at HH:MM, re-running."

## Flow 3: Dashboard (post-MVP, not designed here)

Org verdict history, revert-rate graph, rule-pack editor. Explicitly out of prototype and MVP. No mock in this sprint.

## Prototype scope (this sprint, no code)

Paper/Figma mock of Flow 1 output + Flow 2 card against 1 real Aftergraph PR. Static only.
