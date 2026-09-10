# sentinel — Agent Execution Contract

<!-- Generated 2026-09-10 from REPOSITORY_INVENTORY.json, CI_COMMAND_INVENTORY.json, CI_RESULTS.json and a
     live probe of branch main at HEAD 75fee89e00256ba381d0c2dce36b03c72979e0b4. Revision 1.
     NOTE: the workspace inventory recorded main at 4ef111f; this file was generated
     from the live checkout (main at 75fee89e00256ba381d0c2dce36b03c72979e0b4). Re-verify against your SHA.
     Regenerate the command blocks; hand-edit only the Ratchet section. -->

## Project

  Name        sentinel
  Role        Not declared in the workspace contract — verified code review
  Purpose     Sentinel by Aftergraph — verified code-review: PRs into merge-ready verdicts (strategy docs, prototype-first)
  Languages   JavaScript/TypeScript (Node)

## Local conventions (verified present on disk)

  BUILD:     — not detected in this repository
  TEST:      npm run test
  LINT:      — not detected in this repository
  TYPECHECK: — not detected in this repository
  VERIFY:    — not detected in this repository

  Probes
  - none

Precedence: this file beats the conversation; `/root/workspace/aftergraph/AGENTS.md` beats this file;
verified external state beats both.

## Executed verification (authoritative)

These commands were executed against the exact SHA shown and their result recorded in
`CI_RESULTS.json` (workspace scope). Treat a result from a different SHA as stale.

  npm test  passed  4ef111f6  504 tests passed; zero-dependency Node repository; no install required

  Re-run the row for your SHA before opening a PR. A green run at another SHA proves nothing
  about this one.

## Rules (inherited from the Aftergraph workspace contract)

  - Never commit secrets, tokens, or credentials. Never copy runtime secrets into fixtures, docs, or frontend code.
  - Conventional commits: `feat|fix|docs|refactor|test|chore(scope): description`. Sign off with a verified identity.
  - Run the repository's verification row for your SHA before opening a PR.
  - Evidence-bound: gate results tied to the exact SHA. Evidence from an older SHA is stale, not evidence.
  - Keep PRs narrow and reviewable. Preserve unrelated work. Update an existing PR rather than duplicating it.
  - Check `after-graph-governance/docs/contracts/` for relevant schemas before changing an interface.
  - Verify trust-gateway policy before touching approvals, auth, or budgets.
  - Prefer the smallest reuse-first change. Keep provider boundaries explicit and fail closed.
  - Risk surfaces (authority, permissions, audit, budgets, identity, secrets) require independent verification,
    not self-verification by the implementing agent.
  - Local green output does not prove production readiness. Do not claim completion from it.

## Ratchet — rules learned from observed failures

Every line below must trace to one observed agent failure in THIS repository.
Add a dated line when an agent fails in a new way; fix the strongest layer that prevents recurrence.

  (none recorded yet — this guide has not yet accumulated failure-derived rules)

Choose the strongest applicable layer:
  memory note  <  prompt instruction  <  guide rule  <  sensor (test/lint/schema)  <  environment constraint (permission, CI gate)

If a rule can be checked without human judgement, it does not belong in this list — it belongs in a sensor.

## Guide hygiene

  - Review monthly. Remove rules now enforced by automation. Consolidate rules addressing the same failure class.
  - When the same review comment appears three times, promote it to a gate that blocks the output.
  - Date every entry so stale guidance is identifiable.
  - A rule nobody can verify without subjective judgement is not a rule; rewrite or delete it.
