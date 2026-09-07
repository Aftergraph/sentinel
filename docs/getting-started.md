# Getting started with Sentinel

Review your first diff locally in under five minutes. No GitHub auth, no network.

All commands run from your Sentinel checkout root (the directory containing `bin/sentinel.js`).

## 1. Check Node

Sentinel needs Node 20 or newer (`engines: >=20` in `package.json`).

```bash
node --version
```

You need `v20` or higher.

## 2. Confirm the CLI works

```bash
node bin/sentinel.js --help
```

Exit `0`. It prints the usage lines and the exit-code contract:
`0` SHIP, `1` DO NOT SHIP, `2` STALE.

## 3. Make a sample diff

```bash
printf 'diff --git a/app.js b/app.js\nnew file mode 100644\n--- /dev/null\n+++ b/app.js\n@@ -0,0 +1,3 @@\n+console.log("hello");\n+const x = 1;\n+console.log(x);\n' > /tmp/doccheck/change.diff
```

## 4. Run your first review

```bash
node bin/sentinel.js review --diff /tmp/doccheck/change.diff --repo acme/demo --no-ledger
```

Observed output (exit `0`):

```text
PR: 1 file(s), +3/-0 — top: app.js (+3/-0)
HEAD: local-67cb5f01e30f
SHIP — 0 findings
Advisory (non-blocking): 2
  app.js:1 [no-console-log-in-server-diff] console.log("hello");
  app.js:3 [no-console-log-in-server-diff] console.log(x);
passed-checks: 26
rule-pack: 1.7.0
receipt: 2b2352261545ab90f7a24c93f145fa4e827ceca26b3a8357a9546fa75b9f2135
```

How to read it:

- `HEAD: local-...` — the exact input the verdict binds to. No
  `--head-sha` was given, so this is a content hash of the diff itself.
- `SHIP — 0 findings` — the verdict. Gate on this line and the exit code.
- `Advisory (non-blocking)` — style-level observations. Reported, never block.
- `--no-ledger` skips the local ledger write. Drop the flag (or pass
  `--ledger-path`) once you want receipts.

## 5. Keep a receipt and verify it

Re-run with a ledger file so the receipt is stored:

```bash
node bin/sentinel.js review --diff /tmp/doccheck/change.diff --repo acme/demo --ledger-path /tmp/doccheck/ledger.jsonl --format json > /tmp/doccheck/out.json
```

Exit `0`. The receipt is the last ledger line — extract it and verify offline:

```bash
tail -n 1 /tmp/doccheck/ledger.jsonl > /tmp/doccheck/receipt.json
```

```bash
node bin/sentinel.js verify --receipt /tmp/doccheck/receipt.json
```

Observed output (exit `0`):

```text
VALID — 3fa3e2e9874111c67491190be86b6104e355d0491b066908a4c5c3d08ee5cde7 (SHIP @ local-6, pack 1.6.0)
```

`verify` recomputes one hash. No network, no trust required.
Re-running the same diff yields the same receipt id.

## Exit codes (the whole CI contract)

| Code | Meaning | CI gate |
|------|---------|---------|
| `0` | SHIP (or receipt VALID) | pass |
| `1` | DO NOT SHIP (or receipt INVALID, or usage error) | fail |
| `2` | STALE — HEAD or base moved mid-review, no verdict | re-run, never fail |

Local `--diff` mode never emits STALE (nothing remote to drift against).

## Next steps

- Hit a failure? See `docs/troubleshooting.md`.
- Questions about verdicts, receipts, overrides? See `docs/faq.md`.
- Reference: `docs/receipts-v0.1.md` (receipt/ledger contract),
  `docs/override.md` (break-glass overrides), `docs/rulepack-v1.6.md` (rules).
