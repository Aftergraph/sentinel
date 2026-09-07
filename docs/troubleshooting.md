# Troubleshooting

Each entry shows the exact observed message, the exit code, and the fix.
All entries below were reproduced locally with `review --diff`
(no GitHub, no network). Commands assume the checkout root and the
`/tmp/doccheck/change.diff` fixture from `docs/getting-started.md`.

## 1. INVALID — tampered receipt

Make a tampered copy of a good receipt (flips the verdict without
updating the hash):

```bash
node -e "const fs=require('fs');const r=JSON.parse(fs.readFileSync('/tmp/doccheck/receipt.json','utf8'));r.verdict='DO_NOT_SHIP';fs.writeFileSync('/tmp/doccheck/tampered.json',JSON.stringify(r)+'\n')"
```

```bash
node bin/sentinel.js verify --receipt /tmp/doccheck/tampered.json
```

Observed (exit `1`):

```text
INVALID — receipt_id mismatch: expected 715b6bda67e83bdc7f46ada40daa984f4b6f2a3fa448d836d714c1683421a373, got 3fa3e2e9874111c67491190be86b6104e355d0491b066908a4c5c3d08ee5cde7
```

(The exact ids vary with your edit; the
`INVALID — receipt_id mismatch: expected <...>, got <...>` shape is stable.)

Fix: never hand-edit receipts. Re-run `review` to issue a fresh receipt,
and gate automation on the exit code (`0` VALID, `1` INVALID).

## 2. Unknown rule-pack pin

```bash
node bin/sentinel.js review --diff /tmp/doccheck/change.diff --repo acme/demo --no-ledger --rule-pack 9.9.9
```

Observed (exit `1`, nothing else on stdout):

```text
Error: --rule-pack must be one of 1.0.0, 1.1.0, 1.2.0, 1.3.0, 1.4.0, 1.5.0, 1.6.0 (got "9.9.9")
```

Fix: pin one of the listed versions, or omit the flag for the default
(`1.6.0`, 25 checks). A good pin works:

```bash
node bin/sentinel.js review --diff /tmp/doccheck/change.diff --repo acme/demo --no-ledger --rule-pack 1.0.0
```

Observed (exit `0`): same SHIP verdict with `passed-checks: 6` and
`rule-pack: 1.0.0` instead of 25 / `1.6.0`.

## 3. Unreadable diff file

```bash
node bin/sentinel.js review --diff /tmp/doccheck/does-not-exist.diff --repo acme/demo --no-ledger
```

Observed (exit `1`):

```text
Error: Cannot read diff input: /tmp/doccheck/does-not-exist.diff
```

Fix: check the path, or pipe the diff on stdin with `--diff -`.

## 4. Unreadable receipt file

```bash
node bin/sentinel.js verify --receipt /tmp/doccheck/does-not-exist.json
```

Observed (exit `1`):

```text
INVALID — cannot read receipt: /tmp/doccheck/does-not-exist.json
```

Fix: check the path. Note a missing receipt is INVALID (exit `1`),
not a usage error — gate it as a verification failure.
To extract a receipt, see step 5 of `docs/getting-started.md`.

## 5. Override rejected (fail-closed)

First make a diff with one blocking finding:

```bash
printf 'diff --git a/api.js b/api.js\nnew file mode 100644\n--- /dev/null\n+++ b/api.js\n@@ -0,0 +1,2 @@\n+const x = eval(userInput);\n+console.log(x);\n' > /tmp/doccheck/blocked.diff
```

Override without a reason:

```bash
node bin/sentinel.js review --diff /tmp/doccheck/blocked.diff --repo acme/demo --no-ledger --override SHIP
```

Observed (exit `2`, nothing on stdout):

```text
Error: --override requires --override-reason
```

Override with a bad value:

```bash
node bin/sentinel.js review --diff /tmp/doccheck/blocked.diff --repo acme/demo --no-ledger --override MAYBE --override-reason test
```

Observed (exit `2`, nothing on stdout):

```text
Error: --override must be SHIP or DO_NOT_SHIP (got "MAYBE")
```

Fix: pass `--override-reason <text>`, a value of `SHIP` or `DO_NOT_SHIP`,
and a replacement that differs from the computed verdict.
Rejected overrides record nothing and print no verdict.

## 6. STALE — HEAD or base moved mid-review

- Local `--diff` mode: STALE cannot occur — there is no remote to drift
  against (`--help`: "STALE cannot occur locally"). Nothing to handle.
- PR mode (`review --pr`): a push mid-run aborts with exit `2` and no
  verdict. Fix: re-run the review on the new HEAD. In CI, treat exit `2`
  as re-run, never as failure.
- The `STALE — base moved <old>→<new>, no verdict issued` text is the
  documented contract (`docs/cli-v0-features.md` F-04). It was not
  reproduced live here: reaching it needs a real push mid-review plus
  GitHub auth and network.
