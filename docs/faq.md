# FAQ

## Does REVIEWED mean VERIFIED?

No. Anyone can print "reviewed". A Sentinel verdict means three
checkable things: it names the exact HEAD it verified, it cites
file:line evidence for each blocking finding, and it carries a receipt
anyone can re-verify offline with `verify --receipt`. If HEAD moves
after the review, the verdict no longer applies — in PR mode Sentinel
emits STALE instead of judging a commit nobody will merge.

## What does a receipt prove?

That *this runner* computed *this verdict* for *this exact HEAD* with
*this rule pack*. Concretely, `receipt_id` is the sha256 of the
canonical receipt body, and `verify` recomputes that one hash with no
network and no trust required (`VALID` exit `0`, `INVALID` exit `1`).

What it does not prove matters just as much: the ledger is a local
claim log, not platform audit evidence. A receipt does not establish
conformance, scientific validity, or runtime authority — it composes
upward so platform consumers can ingest it, never so Sentinel can claim
their status. See `docs/receipts-v0.1.md`.

## What does VALID / INVALID mean?

- `VALID` — the receipt hash recomputes cleanly. The verdict and HEAD
  binding are intact.
- `INVALID — receipt_id mismatch` — the receipt body was altered after
  issue (see `docs/troubleshooting.md` §1). Treat the verdict as unproven.
- `INVALID — cannot read receipt` — the file is missing or unreadable
  (see `docs/troubleshooting.md` §4). Treat it as a verification failure.

Gate on the exit code, not on the message text.

## How do overrides work?

`--override` is break-glass: a human operator replaces the computed
verdict with `SHIP` or `DO_NOT_SHIP`, with `--override-reason` (required)
and `--override-actor` recorded in the receipt and the audit log. Human
output appends an `OVERRIDDEN by <actor> (<reason>) — was <verdict>`
line, and the exit code follows the overridden verdict.

Two things to know. First, overrides fail closed: a missing reason, a
bad value, or a replacement equal to the computed verdict is rejected
with exit `2` and records nothing (see `docs/troubleshooting.md` §5).
Second, gate on the exit code, not the human first line: the findings
section still reflects the un-overridden findings, so an override to
SHIP still lists the original findings next to the `OVERRIDDEN` line.
See `docs/override.md`.

## Does a lenient policy or config green a bad diff?

No. Excluded findings (`sentinel.config.json`) are reported but never
block, and a policy verdict can only escalate, never de-escalate: the
final verdict is the strictest of the rule verdict and the policy
verdict. A malformed config or policy fails closed instead of silently
weakening the verdict.

## What does Sentinel NOT do?

- No writes to your repo, PR, or checks. Review is read-only by
  construction; verdicts go to stdout (plus the local ledger file).
- No auto-fix, no auto-approve. The only way to change a verdict is a
  recorded human override.
- No verdict on a moved HEAD. PR mode emits STALE (exit `2`); local
  `--diff` mode binds to the given `--head-sha` or a content hash.
- No borrowed authority. Receipts prove what the runner computed —
  nothing about conformance or production safety.

## Where do I go next?

- First run: `docs/getting-started.md`.
- Exact errors and fixes: `docs/troubleshooting.md`.
- Contracts: `docs/receipts-v0.1.md`, `docs/override.md`,
  `docs/policy.md`, `docs/rulepack-v1.6.md`.
