import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createConsoleServer } from '../console/server.js';
import { analyzeDiff } from '../lib/review.js';
import { load as loadMemory } from '../lib/memory.js';
import { RULE_PACK_VERSION } from '../lib/rulepack.js';

const DIFF = `diff --git a/srv/app.js b/srv/app.js
index 1111111..2222222 100644
--- a/srv/app.js
+++ b/srv/app.js
@@ -1,3 +1,5 @@
 export function run(input) {
+  return eval(input);
+  var leftover = 1;
 }
`;

// UI/api result must equal the CLI verdict path for the same diff:
// same lib, byte-identical findings. Receipt identity fields
// (run_id/timestamp) legitimately differ per run and are excluded.
test('console: /api/review equals the CLI verdict path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-equiv-'));
  try {
    const ledger = join(dir, 'ledger.jsonl');
    const mem = join(dir, 'mem.jsonl');
    const handler = createConsoleServer({ ledgerPath: ledger, memoryPath: mem });
    const server = createServer(handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const res = await fetch(`${base}/api/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ diff: DIFF, repo: 'o/r', pr: 11 }),
      });
      assert.equal(res.status, 200);
      const api = await res.json();

      const { result } = await analyzeDiff({
        diffText: DIFF, pack: RULE_PACK_VERSION, excludePatterns: [],
        resolutions: loadMemory(mem), headSha: api.review.headSha, baseSha: api.review.baseSha,
      });
      assert.equal(api.verdict, result.verdict);
      assert.deepEqual(api.findings.blocking, result.blocking);
      assert.deepEqual(api.findings.nonBlocking, result.nonBlocking);
      assert.deepEqual(api.findings.excluded, result.excluded);
      assert.equal(api.checksPassed, result.checksPassed);
    } finally {
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
