# Sentinel CLI Live-Fire Proofs

**Date:** 2026-09-07
**Sentinel HEAD:** 4b0007c
**Throwaway repo:** Aftergraph/sentinel-firetest (deleted after proof)

## Proof 1: Exit-1 (DO NOT SHIP)

**Objective:** Prove exit code 1 fires on a real PR with in-pack violations.

**Setup:**
- Branch `proof/violations` with two commits adding:
  - `.github/workflows/ci.yml:7` — literal `API_KEY: sk_live_...` (trips `no-secrets-in-cicd-config`)
  - `src/routes.js:2` — `app.delete("/api/users/:id", ...)` without auth middleware (trips `no-unauthenticated-api-endpoints`)
- PR #1 opened against `main`

**Command:**
```
node bin/sentinel.js review --pr 1 --repo Aftergraph/sentinel-firetest
```

**Result:**
- **Exit code:** 1
- **Verdict:** DO NOT SHIP — 2 finding(s)
- **Findings:**
  - `.github/workflows/ci.yml:7 [no-secrets-in-cicd-config] API_KEY: sk_liv...cdef`
  - `src/routes.js:2 [no-unauthenticated-api-endpoints] app.delete("/api/users/:id", (req, res) => {`
- **HEAD SHA:** 5559aed026d0fa6848be1d3b1d7f76855c7e0edd
- **passed-checks:** 6

**Status:** ✅ PROVEN

---

## Proof 2: Exit-2 (STALE)

**Objective:** Prove exit code 2 fires when PR base moves mid-review.

**Challenge:** GitHub does not auto-update a PR's `base.sha` when the base branch advances. The `update-branch` API must be called explicitly to propagate the new base SHA to the PR object. Without this, sentinel's second API call sees the same frozen base SHA and never triggers STALE.

**Strategy:**
1. Push commit to `main` via Contents API
2. Call `PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch` to sync PR base
3. Start sentinel (captures baseShaStart)
4. Sleep 1.0s (sentinel fetches diff + runs rules)
5. Push another commit to `main` + call `update-branch` again
6. Sentinel's second API call sees changed base.sha → exit 2

**Result:**
- **Exit code:** 2
- **Output:** `STALE — base moved from 0d16f04 to 3e5da05`
- **Iteration:** 1 (hit on first attempt once update-branch was used)
- **Findings printed:** 0 (STALE exits before verdict)

**Flakiness notes:**
- Without `update-branch`, STALE is unprovable — ran 60+ iterations across 3 strategies with zero hits.
- With `update-branch`, hit reliably on iter 1 with 1.0s sleep window.
- Race window depends on GitHub API latency; 0.8–1.5s sleep should be robust. Below 0.5s risks sentinel finishing before mid-push lands.
- This is an inherent TOCTOU design: sentinel checks base stability by sampling twice. The check is sound but the window is narrow on fast networks.

**Status:** ✅ PROVEN (with update-branch prerequisite documented)

---

## Summary

| Exit Code | Verdict     | Proven | Iterations | Notes                              |
|-----------|-------------|--------|------------|------------------------------------|
| 0         | SHIP        | Yes    | n/a        | Dogfood replay already proved      |
| 1         | DO_NOT_SHIP | ✅     | 1          | Two findings, correct file:line    |
| 2         | STALE       | ✅     | 1          | Requires update-branch API call    |
