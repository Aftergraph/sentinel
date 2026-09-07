# Sentinel offline demo — one real finding, end to end

Deterministic, offline, no GitHub/auth/network. Uses only the basic
committed CLI flow: `review --diff` then `verify --receipt`.

Run every command from the repo root (this directory ships as `demo/`).
Node >= 20. Each review appends a receipt to your local ledger
(`~/.sentinel/ledger.jsonl`); the verdict lines below are unaffected.

## Step 1 — inspect the diff

```
cat demo/pr.diff
cat demo/payments-api/refunds.js
```

The PR adds `refunds.js`. Line 4 is the bug:

```
  return refund.amount == 0;
```

Loose `==` coerces: `'' == 0` and `false == 0` are both `true`, so a
missing/empty amount is treated as a free refund. The fix is `===`.

## Step 2 — the finding

```
node bin/sentinel.js review --diff demo/pr.diff --repo demo/payments-api
```

Observed (exit 1):

```
DO NOT SHIP — 1 finding(s)
  refunds.js:4 [require-strict-equality] return refund.amount == 0;
```

Exactly one blocking finding. Rule: `require-strict-equality`
(correctness, blocking). Full human output is pinned in `EXPECTED.md`.

## Step 3 — verification run

Capture the machine output, extract the receipt, verify it offline:

```
node bin/sentinel.js review --diff demo/pr.diff --repo demo/payments-api --format json > /tmp/demo-review.json
node -e "const fs = require('fs'); const j = JSON.parse(fs.readFileSync('/tmp/demo-review.json', 'utf8')); fs.writeFileSync('/tmp/demo-receipt.json', JSON.stringify(j.receipt, null, 2)); console.log('receipt_id: ' + j.receipt.receipt_id);"
node bin/sentinel.js verify --receipt /tmp/demo-receipt.json
```

Observed (exit 0):

```
VALID — a74cc03db8dd263b0bcf1fc67d918b1aa019b7a37b5a9a18b22f6ffa9ed5f396 (DO_NOT_SHIP @ local-8, pack 1.7.0)
```

Independent dynamic check — the fixture's own tests plus a coercion
probe proving the finding points at a genuine bug:

```
cd demo/payments-api && node --test
node --input-type=module -e "import('./refunds.js').then(m => { console.log('amount 0 ->', m.isFreeRefund({ amount: 0 })); console.log('amount 100 ->', m.isFreeRefund({ amount: 100 })); console.log('amount empty-string ->', m.isFreeRefund({ amount: '' })); });"
```

Observed: tests pass (`pass 2`, `fail 0`) — the committed tests miss the
edge — while the probe prints `amount empty-string -> true`, which must
be `false`. Static review catches what the tests miss.

## Step 4 — evidence

What to cite (finding shape is evolving, so cite scalars only):

- verdict: `DO_NOT_SHIP`, rule: `require-strict-equality`
- location + evidence: `refunds.js:4`, `return refund.amount == 0;`
- receipt: `a74cc03db8dd263b0bcf1fc67d918b1aa019b7a37b5a9a18b22f6ffa9ed5f396`
- receipt check: `VALID — ... (DO_NOT_SHIP @ local-8, pack 1.7.0)`

## Step 5 — verdict transition

Rule: 0 blocking findings → `SHIP` (exit 0); ≥1 blocking → `DO_NOT_SHIP`
(exit 1). This PR has 1 blocking, so the verdict is `DO_NOT_SHIP`.

Try the transition — one-line fix, re-review:

```
sed 's/== 0/=== 0/' demo/pr.diff > /tmp/fix.diff
node bin/sentinel.js review --diff /tmp/fix.diff --repo demo/payments-api
```

Observed (exit 0):

```
SHIP — 0 findings
```

## Determinism notes

- Stable across reruns: verdict, rule id, `file:line`, evidence text,
  `HEAD: local-8ac6ff7b0861`, `receipt: a74cc03...`, `VALID` line,
  `rule-pack: 1.7.0`, `passed-checks: 26`.
- Varies (never asserted): `run_id`, `timestamp` inside the JSON/ledger
  receipt; the `VALID` line stays identical.
- A `Since <sha>: +N new, -M fixed` delta section appears only when your
  ledger already holds a prior receipt for the same repo+PR — it compares
  against local history and never changes the verdict.

## Layout

```
demo/README.md            this walkthrough
demo/pr.diff              the PR: adds refunds.js (9 lines, 1 bug)
demo/payments-api/refunds.js       fixture source (bug on line 4)
demo/payments-api/refunds.test.js  fixture tests (green; miss the edge)
demo/payments-api/package.json     fixture manifest (type: module)
demo/EXPECTED.md          pinned observed outputs
