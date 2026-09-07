#!/usr/bin/env bash
set -euo pipefail

node bin/sentinel.js review --pr 41 --repo Aftergraph/studio > /tmp/smoke.out 2>&1
exit_code=$?

if [ $exit_code -ne 0 ]; then
  echo "FAIL: exit code was $exit_code, expected 0"
  cat /tmp/smoke.out
  exit 1
fi

if ! grep -q '^HEAD: [0-9a-f]\{40\}$' /tmp/smoke.out; then
  echo "FAIL: HEAD line not found in output"
  cat /tmp/smoke.out
  exit 1
fi

echo "PASS: exit 0, HEAD line present"
cat /tmp/smoke.out
rm -f /tmp/smoke.out
