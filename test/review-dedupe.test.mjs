import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDiff } from '../lib/review.js';

// Two sliding windows (nested loops) covering one query line must yield ONE
// finding, not two: exact duplicates carry no independent signal.
const NESTED_LOOP_DIFF = `diff --git a/srv/items.mjs b/srv/items.mjs
index 1111111..2222222 100644
--- a/srv/items.mjs
+++ b/srv/items.mjs
@@ -1,3 +1,7 @@
+for (const a of as) {
+  for (const b of bs) {
+    out = await db.items.find(b);
+  }
+}
`;

function allFindings(result) {
  return [...(result.blocking || []), ...(result.nonBlocking || []), ...(result.silenced || []), ...(result.excluded || [])];
}

test('review: exact-duplicate findings are emitted once', async () => {
  const { result } = await analyzeDiff({ diffText: NESTED_LOOP_DIFF, pack: '1.6.0' });
  const hits = allFindings(result).filter((f) => f.ruleId === 'no-n-plus-one-queries-in-api-resolvers');
  assert.equal(hits.length, 1, `expected 1 deduplicated finding, got ${hits.length}`);
});
