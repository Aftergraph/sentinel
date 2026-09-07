# EXPECTED.md — pinned observed outputs for the offline demo

Captured with Node v24.18.1, rule-pack 1.6.0, fresh ledger (no `Since`
delta section). Finding JSON is deliberately not quoted (shape is
evolving); verdict, rule id, and VALID lines are the contract.

## 1. review (human) — exit 1

```
node bin/sentinel.js review --diff demo/pr.diff --repo demo/payments-api
```

```
PR: 1 file(s), +9/-0 — top: refunds.js (+9/-0)
HEAD: local-8ac6ff7b0861
DO NOT SHIP — 1 finding(s)
  refunds.js:4 [require-strict-equality] return refund.amount == 0;
passed-checks: 25
rule-pack: 1.6.0
receipt: 685e102b0a5aa1388b506de0e421d4f30215c7a6f0e2bae6c95daa8188289177
```

## 2. verify (receipt) — exit 0

```
node bin/sentinel.js verify --receipt /tmp/demo-receipt.json
```

```
VALID — 685e102b0a5aa1388b506de0e421d4f30215c7a6f0e2bae6c95daa8188289177 (DO_NOT_SHIP @ local-8, pack 1.6.0)
```

Receipt scalars behind the VALID line (from `--format json` + `.receipt`
extract): `verdict: DO_NOT_SHIP`, `counts.blocking: 1`,
`receipt_id: 685e102b0a5aa1388b506de0e421d4f30215c7a6f0e2bae6c95daa8188289177`.

## 3. fixture tests — exit 0

```
cd demo/payments-api && node --test
```

```
✔ isFreeRefund treats zero amount as free
✔ formatAmount renders dollars
ℹ pass 2
ℹ fail 0
```

## 4. coercion probe (genuine-bug evidence) — exit 0

```
node --input-type=module -e "import('./refunds.js').then(m => { ... });"
```

```
amount 0 -> true
amount 100 -> false
amount empty-string -> true
```

`amount empty-string -> true` is the bug: it must be `false`.

## 5. fix preview (`==` → `===`) — exit 0

```
sed 's/== 0/=== 0/' demo/pr.diff > /tmp/fix.diff
node bin/sentinel.js review --diff /tmp/fix.diff --repo demo/payments-api
```

```
SHIP — 0 findings
```

## What varies (never assert)

- `run_id`, `timestamp` inside JSON/ledger receipts.
- A `Since <sha>: +N new, -M fixed` delta section when the ledger already
  holds a prior receipt for the same repo+PR (local-history comparison;
  verdict and receipt for a given diff are unaffected).
