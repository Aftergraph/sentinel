#!/usr/bin/env bash
set -euo pipefail

# Smoke test: run rule tests and verify CLI scaffold still works
node --test test/rules.test.mjs test/memory-sarif.test.mjs test/exact-head.test.mjs test/cli-contract.test.mjs test/receipts.test.mjs

node bin/sentinel.js review --pr 41 --repo Aftergraph/studio > /tmp/smoke.out 2>&1
exit_code=$?

# exit_code is 0 (SHIP) or 1 (DO NOT SHIP) — both acceptable; STALE is 2
if [ $exit_code -gt 1 ]; then
  echo "FAIL: exit code was $exit_code (unexpected)"
  cat /tmp/smoke.out
  exit 1
fi

if ! grep -q '^HEAD: [0-9a-f]\{40\}$' /tmp/smoke.out; then
  echo "FAIL: HEAD line not found in output"
  cat /tmp/smoke.out
  exit 1
fi

echo "PASS: rule tests green, exit $exit_code, HEAD line present"
cat /tmp/smoke.out
rm -f /tmp/smoke.out
