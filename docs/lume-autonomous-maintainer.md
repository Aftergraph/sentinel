# Lume autonomous maintainer

Status: first governed implementation slice.

## Goal

Let Sentinel continuously improve `Aftergraph/Lume` without turning the
reviewer into an unrestricted repository bot.

The closed loop is:

```text
observe -> find -> brainstorm -> bound risk -> remediate on branch
       -> PR -> independent CI -> Sentinel verify -> merge steward
       -> production verify -> production release -> post-deploy evidence
```

Sentinel stays the verifier and policy owner. A separately-scoped maintainer
worker is the implementing actor. The worker never receives direct-main or
direct-deploy authority.

## Existing production substrate

- Sentinel's VDS GitHub App poller already includes `Aftergraph/Lume` through
  `ops/deploy/poll-repos.json`.
- Lume already has `Sentinel gate`, `Merge steward`, `Production verify`
  and `Production release`.
- Therefore this feature reuses the current evidence/merge/release chain; it
  does not introduce a second deployment system.

## Autonomy envelope

The canonical target policy is `ops/maintainers/lume.json`.

Automatic PR remediation is limited to low/medium-risk reliability,
correctness, performance and style work under the allowed paths. Security,
identity, authority, credentials, policy, deployment/workflow and other
protected surfaces stay proposal/review territory.

`lib/maintainer-policy.js` is the fail-closed decision layer. Its only
write-capable outcome is `REMEDIATE_PR`.

There is deliberately no `PUSH_MAIN` or `DEPLOY` outcome.

## Required executor contract

The implementing worker must:

1. bind every task to an exact Lume base SHA;
2. create a fresh `sentinel/<finding-or-task-id>` branch;
3. preserve unrelated work;
4. produce a structured change plan before editing;
5. run the focused tests plus repository gates requested by policy;
6. push only the task branch;
7. open/update one PR with the exact-head evidence;
8. never approve its own PR;
9. never mutate `main` directly;
10. never call the production deploy workflow directly.

The worker may brainstorm multiple candidate repairs, but only the selected
candidate enters the branch. Candidate selection must record why the chosen
patch is safer/smaller than alternatives.

## Verification and promotion

A remediation PR is merge-eligible only after the configured independent
checks are green on the exact current PR HEAD and Sentinel has re-reviewed that
same HEAD.

Lume's existing Merge Steward owns merging. Lume's Production Verify and
Production Release own deployment. If any required evidence becomes stale
because the head moves, the loop returns to verification.

## Next implementation slice

Wire the VDS maintainer worker to consume Sentinel findings and Lume health /
regression signals, then create/update remediation branches and PRs under this
policy. The GitHub App reviewer remains read-mostly; the worker receives a
separate installation token/credential scope so compromise of remediation
authority cannot silently weaken verification authority.
