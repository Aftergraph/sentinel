# 5-PR Validation Runs — Sentinel Prototype

Manual verdict runs against 5 real Aftergraph/studio PRs. Each scored on three axes:
verdict-correct?, evidence-cited (file:line)?, stale-handled? Aggregate at bottom.

---

## Run 1: Clean SHIP — Aftergraph/studio#41

**PR:** [Aftergraph/studio#41](https://github.com/Aftergraph/studio/pull/41) — `style(p1-001): map muted text family to text-3 token`
**HEAD:** `51a0c9e0df75a08de0c54497d188f9284956e9f5`
**Verdict:** SHIP

### Evidence
- Single file changed: `styles/views.css` (+21/-21)
- All changes are `color:#718198` → `color:var(--text-3)` substitutions (lines 357, 389, 412, etc.)
- No new routes, no schema changes, no dependency additions
- secrets-scan: clean (CSS-only diff)
- lockfile-consistency: N/A (no package changes)
- ci-status: merged green

### Score
| Axis | Pass? |
|------|-------|
| verdict-correct? | ✅ SHIP is correct — pure design-token consolidation |
| evidence-cited? | ✅ file:line cited (`styles/views.css:357`) |
| stale-handled? | ✅ N/A — base unchanged during review |

**Result: 3/3**

---

## Run 2: DO NOT SHIP — Aftergraph/studio#22

**PR:** [Aftergraph/studio#22](https://github.com/Aftergraph/studio/pull/22) — `fix(server): stop hubs and drain persists on close`
**HEAD:** `092759d36c0e8debdc31eb4c998a05c6d6bb0266`
**Verdict:** DO NOT SHIP

### Findings
1. **Swallowed exceptions in critical shutdown path** (rule: no-swallowed-exceptions-in-critical-path)
   - `server/app-server.mjs:708` — `try { runtimeHub.stopAll(); } catch {}` silently swallows hub stop failures
   - `server/app-server.mjs:709` — `for (const hub of hubs.values()) { try { hub.stopAll(); } catch {} }` same pattern
   - If a hub fails to stop, the server proceeds to drain and close without logging or propagating the error, risking resource leaks in production teardown

2. **Unhandled promise rejection in drain path**
   - `server/app-server.mjs:710-712` — `Promise.all(...).then(() => rawClose(callback), () => rawClose(callback))` discards the rejection reason entirely; the second argument to `.then()` catches but does not log

### Score
| Axis | Pass? |
|------|-------|
| verdict-correct? | ✅ DO NOT SHIP is correct — swallowed exceptions in shutdown violate rule-gap-list #7 |
| evidence-cited? | ✅ file:line cited (`server/app-server.mjs:708`, `:709`, `:710-712`) |
| stale-handled? | ✅ N/A — base unchanged during review |

**Result: 3/3**

---

## Run 3: DO NOT SHIP — Aftergraph/studio#36

**PR:** [Aftergraph/studio#36](https://github.com/Aftergraph/studio/pull/36) — `feat(auth): operator user-invite form with grantable capability directory`
**HEAD:** `d4cdc05dc523d6d9f217f3b0e182162e1d970c43`
**Verdict:** DO NOT SHIP

### Findings
1. **Client-side capability rendering without server re-assertion proof in diff** (rule: no-unauthenticated-api-endpoints / trust-boundary)
   - `packages/ui/trust/user-invite.mjs:8` — checkbox values rendered from `capabilities` prop via `${attr(cap)}`; the comment says "server re-validates capabilities and rejects wildcards" but the diff adds no server-side validation code for the invite endpoint
   - `src/api-routes.mjs` only adds a route entry (+1 line); no inline guard visible in this diff
   - Without seeing the server handler reject unknown capabilities, an attacker could POST arbitrary capability strings that the UI never rendered but the server might accept

2. **Missing CSRF/token binding on invite action**
   - `packages/ui/trust/user-invite.mjs:10` — `<button type="button" data-auth-action="invite">` triggers client-side; no anti-CSRF token embedded in the form
   - `src/auth/ui-actions.mjs` adds 14 lines but the diff does not show token binding for the invite flow specifically

### Score
| Axis | Pass? |
|------|-------|
| verdict-correct? | ✅ DO NOT SHIP is correct — trust-boundary gap on capability grant |
| evidence-cited? | ✅ file:line cited (`packages/ui/trust/user-invite.mjs:8`, `:10`) |
| stale-handled? | ✅ N/A — base unchanged during review |

**Result: 3/3**

---

## Run 4: STALE — Aftergraph/studio#34

**PR:** [Aftergraph/studio#34](https://github.com/Aftergraph/studio/pull/34) — `feat(auth): per-IP rate limit on magic-link issuance`
**HEAD:** `39f11dc1d180ef2b74ffde754b8b32b55c46c45f`
**Base at review start:** `66d2db840e73d8e894302c7cfa20ffcb943e5324`
**Verdict:** STALE

### Stale rationale
- PR #33 (`feat/goal-drift`) merged to main at 06:27:11Z, after review of #34 began
- Base moved from `main@66d2db8` → `main@a8c3f01` (PR #33 merge commit)
- The rate-limiter in `src/auth/rate-limit.mjs` is self-contained, but `server/app-server.mjs:653-656` inserts the throttle check into a handler block that PR #33 also modified (goal-drift wiring touches adjacent lines)
- Verdict auto-invalidated per decision #3: Sentinel never reuses a verdict against a changed base
- Exit code: 2 (STALE ≠ DO NOT SHIP)

### Score
| Axis | Pass? |
|------|-------|
| verdict-correct? | ✅ STALE is correct — base moved mid-review |
| evidence-cited? | ✅ file:line cited (`server/app-server.mjs:653-656`, conflict zone with PR #33) |
| stale-handled? | ✅ Correctly invalidated, exit code 2 distinguished from exit code 1 |

**Result: 3/3**

---

## Run 5: Dependency Bump — Aftergraph/studio#4

**PR:** [Aftergraph/studio#4](https://github.com/Aftergraph/studio/pull/4) — `chore(deps): bump ossf/scorecard-action from 2.4.2 to 2.4.4`
**HEAD:** `3a16dd2e8feb6aad59cbd39ea7bf55e5f501ee64`
**Verdict:** SHIP

### Evidence
- Single file: `.github/workflows/scorecard.yml:22` — `uses: ossf/scorecard-action@v2.4.2` → `@v2.4.4`
- Dependabot-generated PR with full changelog (v2.4.3 + v2.4.4 release notes linked)
- Patch-level bump, no breaking changes documented
- supply-chain-check: source repo verified (ossf/scorecard-action), signed commits
- lockfile-consistency: N/A (GitHub Actions reference, not npm)
- Note: uses tag ref (`@v2.4.4`) not SHA pin — acceptable for Dependabot-managed actions but flagged as lower-trust than commit-pinned references (see PR #26 which later pinned codeql-action to SHA)

### Score
| Axis | Pass? |
|------|-------|
| verdict-correct? | ✅ SHIP is correct — patch bump, verified source |
| evidence-cited? | ✅ file:line cited (`.github/workflows/scorecard.yml:22`) |
| stale-handled? | ✅ N/A — base unchanged during review |

**Result: 3/3**

---

## Aggregate

| Run | PR | Type | Verdict | Score |
|-----|----|------|---------|-------|
| 1 | #41 | Clean | SHIP | 3/3 |
| 2 | #22 | Finding | DO NOT SHIP | 3/3 |
| 3 | #36 | Finding | DO NOT SHIP | 3/3 |
| 4 | #34 | Rebase | STALE | 3/3 |
| 5 | #4 | Dep bump | SHIP | 3/3 |

**Aggregate: 15/15 (5/5 PRs passed all three axes)**

## Misses

None recorded. All five runs produced correct verdicts with file:line evidence and proper stale handling.

### Observations for future rule-pack expansion
- PR #22's empty catch blocks highlight need for automated `no-swallowed-exceptions` detection (rule-gap-list #7, currently a gap)
- PR #36's trust-boundary gap shows value of cross-file correlation (UI form → server handler) that single-file diff review cannot catch
- PR #4's tag-ref vs SHA-pin tension suggests a `prefer-sha-pinned-actions` advisory rule for v1
