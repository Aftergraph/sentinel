# Sentinel CLI Live-Fire Proofs — Historical Exact-HEAD Evidence

> **Evidence boundary:** these are real live-fire proofs at Sentinel HEAD `4b0007c` on 2026-09-07. They prove the documented behavior at that exact implementation, not automatically at current `main`. Re-run the same exit semantics at current HEAD before calling them current-head proof. See `docs/evidence-status.md`.

**Date:** 2026-09-07  
**Sentinel HEAD:** `4b0007c`  
**Throwaway repo:** `Aftergraph/sentinel-firetest` (deleted after proof)

## Proof 1: Exit-1 (`DO NOT_SHIP`)

**Objective:** prove exit code 1 fires on a real PR with in-pack violations.

**Setup:**
- branch `proof/violations` with two commits adding:
  - `.github/workflows/ci.yml:7` — literal `API_KEY: sk_live_...` (trips `no-secrets-in-cicd-config`)
  - `src/routes.js:2` — `app.delete("/api/users/:id", ...)` without auth middleware (trips `no-unauthenticated-api-endpoints`)
- PR #1 opened against `main`

**Command:**
```sh
node bin/sentinel.js review --pr 1 --repo Aftergraph/sentinel-firetest
```

**Observed result at `4b0007c`:**
- exit code: 1
- verdict: `DO_NOT_SHIP` — 2 findings
- findings:
  - `.github/workflows/ci.yml:7 [no-secrets-in-cicd-config] API_KEY: sk_liv...cdef`
  - `src/routes.js:2 [no-unauthenticated-api-endpoints] app.delete("/api/users/:id", (req, res) => {`
- target HEAD SHA: `5559aed026d0fa6848be1d3b1d7f76855c7e0edd`
- passed-checks: 6

**Status:** ✅ PROVEN AT SENTINEL HEAD `4b0007c`

---

## Proof 2: Exit-2 (`STALE`)

**Objective:** prove exit code 2 fires when PR base state changes during review.

**Observed prerequisite:** advancing the base branch alone did not change the PR object's sampled `base.sha` in the tested setup. The live-fire harness called the update-branch API so the PR object reflected the changed base before Sentinel's second sample.

**Strategy used:**
1. push commit to `main` via Contents API;
2. call `PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch` to sync the PR base;
3. start Sentinel (captures `baseShaStart`);
4. sleep 1.0 s while Sentinel fetches diff and runs rules;
5. push another commit to `main` + update the PR branch again;
6. Sentinel's second PR sample observes a different base SHA and returns exit 2.

**Observed result at `4b0007c`:**
- exit code: 2
- output: `STALE — base moved from 0d16f04 to 3e5da05`
- iteration: 1 once the update-branch prerequisite was used
- findings printed: 0 (`STALE` exits before verdict)

**Flakiness / scope notes:**
- 60+ attempts across three strategies without update-branch produced no STALE event in that harness.
- with update-branch, the documented 1.0 s timing hit on the first attempt;
- the race window is transport-latency dependent and therefore is not a deterministic static fixture;
- this proof demonstrates sampled base-change invalidation in the tested GitHub flow. It does not prove that every kind of upstream branch movement mutates GitHub's PR `base.sha` automatically.

**Status:** ✅ PROVEN AT SENTINEL HEAD `4b0007c` WITH THE DOCUMENTED UPDATE-BRANCH PREREQUISITE

---

## Summary

| Exit code | Verdict | Historical proof | Scope |
|---|---|---|---|
| 0 | `SHIP` | Yes | Historical dogfood replay |
| 1 | `DO_NOT_SHIP` | ✅ | Real in-pack violations at `4b0007c` |
| 2 | `STALE` | ✅ | Controlled base-state change at `4b0007c` |

## Required successor

Repeat all three outcomes at current Sentinel HEAD and store exact Sentinel commit, target commit(s), command, output/receipt and environment. Until that exists, describe this artifact as **historical exact-HEAD live proof**, not “current behavior proven.”
