#!/usr/bin/env bash
# Console smoke: boot serve, healthz, review round-trip, PWA content types.
set -euo pipefail

D=$(mktemp -d)
trap 'kill $PID 2>/dev/null; rm -rf "$D"' EXIT

node bin/sentinel.js serve --port 18787 --ledger-path "$D/ledger.jsonl" \
  --memory-path "$D/mem.jsonl" --repo Aftergraph/sentinel >"$D/serve.log" 2>&1 &
PID=$!

for i in $(seq 1 50); do
  curl -sf http://127.0.0.1:18787/api/healthz >/dev/null 2>&1 && break
  sleep 0.2
done
curl -sf http://127.0.0.1:18787/api/healthz | grep -q '"ok":true'

printf 'diff --git a/a.js b/a.js\nindex 1111111..2222222 100644\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n' >"$D/clean.diff"
curl -sf -X POST http://127.0.0.1:18787/api/review \
  -H 'content-type: application/json' \
  -d "{\"diff\":$(node -e "console.log(JSON.stringify(require('node:fs').readFileSync('$D/clean.diff','utf8')))"),\"repo\":\"o/r\",\"pr\":1}" \
  | grep -q '"verdict":"SHIP"'

curl -sf http://127.0.0.1:18787/ | grep -q 'Sentinel Console'
curl -sfI http://127.0.0.1:18787/manifest.webmanifest | grep -qi 'application/manifest+json'
curl -sf http://127.0.0.1:18787/api/rules | grep -q 'no-eval-with-dynamic-input'

echo "PASS: console smoke (healthz, review, shell, manifest, rules)"
