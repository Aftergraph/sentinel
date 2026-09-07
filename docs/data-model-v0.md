# Data model v0 — Sentinel by Aftergraph

**Wedge guardrail:** Sentinel turns pull requests into merge-ready verdicts. First wedge: CLI review on exact HEAD → SHIP / DO NOT SHIP verdict with cited evidence → GitHub App.

## Entities (frozen records, immutable after issue)

- **Review** `{ id, repo, prNumber, headSha, baseSha, rulePackVersion, modelId, startedAt, completedAt, status: verifying | complete | stale }`
  - `stale` is set automatically when `baseSha` moves mid-review. A stale review can never become a verdict.
- **Verdict** `{ reviewId, decision: SHIP | DO_NOT_SHIP, findingIds[], checksPassed[], issuedAt }`
  - Bound 1:1 to the verified `headSha`. Any new push requires a new Review.
- **Finding** `{ id, reviewId, severity: security | reliability | correctness | style, ruleId, file, line, evidence: string, status: open | resolved | dismissedWithReason }`
  - Resolved findings are never re-reported on the same HEAD.
- **EvidenceRef** `{ kind: file | ciRun | diffHunk | ruleDoc, ref: string }` — every finding carries ≥1.
- **RulePack** `{ version, rules: [{ id, title, severity, pattern }] }` — org-owned, versioned, auditable.

## Explicit non-entities (v0)

No User table (GitHub identity via App; CLI runs as the invoking engineer). No auto-fix patches. No comment threads stored (GitHub owns them; we store verdict + findings only).
