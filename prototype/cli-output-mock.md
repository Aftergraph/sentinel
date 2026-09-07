# CLI Output Mock — Flow 1: Aftergraph/studio#41

**PR:** [Aftergraph/studio#41](https://github.com/Aftergraph/studio/pull/41) — `style(p1-001): map muted text family to text-3 token`
**HEAD:** `51a0c9e0df75a08de0c54497d188f9284956e9f5` (branch `style/muted-text-family`)
**Base:** `main@d6850dc23d1dd356a16f3221317513221b8dc799`
**Merged:** 2026-09-07T08:06:49Z

This mock renders the three Flow 1 states exactly as `docs/ui-flows.md` specifies.

---

## State 1: VERIFYING (live HEAD pinning)

```
$ sentinel review --pr 41
VERIFYING… HEAD 51a0c9e, base main@d6850dc (pinning — base unchanged since review start)
```

---

## State 2: Verdict (SHIP — 0 findings)

```
$ sentinel review --pr 41
HEAD 51a0c9e (verified: base main@d6850dc unchanged since review start)

SHIP — 0 findings

6 checks passed: secrets-scan, lockfile-consistency, diff-size(78921 chars, views.css only),
  token-coverage(var(--text-3) mapped in 9 selectors), css-lint(clean), ci-status(merged green).
```

**Verdict rationale:** The diff is a pure design-token consolidation — nine hardcoded `color:` values in `styles/views.css` replaced with `var(--text-3)`. No new routes, no schema changes, no dependency additions, no secret exposure. All rule-pack checks pass; no merge-blocking findings.

---

## State 3: STALE (base moved during review)

```
$ sentinel review --pr 41
HEAD 51a0c9e (STALE: base moved main@d6850dc → main@a1b2c3d during review)

⚠ STALE — verdict invalidated. Re-run against new HEAD.
  The base branch received 1 new commit since review started.
  Sentinel never reuses a verdict against a changed base (decision #3).

$ echo $?
2
```

**Exit code 2 on STALE** is distinct from exit code 1 (findings present / DO NOT SHIP). A clean SHIP exits 0; DO NOT SHIP exits 1; STALE exits 2 so CI can distinguish "needs human re-review" from "code has findings."

---

## Diff sample cited in verdict

```
# styles/views.css — line 357 (representative)
-.ag-conversation-head p{...color:#718198}
+.ag-conversation-head p{...color:var(--text-3)}
```

Nine selectors received the same token mapping: `.ag-conversation-head p`,
`.ag-detail-list dt`, `.ag-mission-rail small`, `.ag-work-detail small`,
`.ag-work-detail header p`, `.ag-work-meta span`, `.ag-work-meta small`,
`.ag-work-trajectory small`, `.ag-context-summary dt`, `.ag-memory-item small`,
`.ag-work-summary small`, `.ag-domain-header>span`, `.ag-section-heading>small`,
`.ag-agent-card small`, `.ag-artifact-row small`, `.ag-semantic-zoom button`,
`.ag-temporal-modes button`, `.ag-intent-composer footer button`.

---

## Prototype notes

- Static mock only. No code executed.
- LF line endings (verified: 0 × `\r` bytes).
- Rule-pack references use names from `docs/validation-plan.md` rule #2
  (token-coverage, css-lint, diff-size, secrets-scan, lockfile-consistency, ci-status).
- Exit-code contract: 0 = SHIP, 1 = DO NOT SHIP (findings), 2 = STALE (base moved).
