---
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  copilot-requests: write

engine: copilot

timeout-minutes: 15

network: defaults

tools:
  bash: ["node *", "npm *", "git *", "ls *", "cat *"]

safe-outputs:
  add-comment:
    max: 1
---

# Sentinel verdict review

You are reviewing the pull request that triggered this run. Sentinel's rule is that a
verdict is worth nothing unless it is bound to the exact commit it was evaluated on, so
every claim you make here must name that commit.

## What to do

1. Record the exact head commit of this pull request. Every statement below is about that
   commit and no other.
2. Install dependencies and run the test suite:

   ```bash
   npm ci
   npm test
   ```

3. Run Sentinel against the pull request head using the repository CLI in `bin/sentinel.js`.
   Read `docs/` first if you need the exact invocation.
4. Read the diff and look for blocking findings that the policy engine would surface:
   unbound verdicts, evidence taken from a different commit, a required check treated as
   present when it reports another head, and any path where a failure is downgraded to a pass.

## What to report

Post a single comment with:

- the exact head commit you evaluated, in full,
- the test result as a count of passing and failing tests, not a summary adjective,
- each blocking finding with the file and line it sits on,
- an explicit statement of anything you could not verify.

Never report a pass you did not observe. If the suite did not run to completion, say that
instead of reporting a verdict. An unverified claim is a worse outcome than no claim.
