// S2 slice 2: advisory blast-radius context on review findings.
// Finding-context unit tests + receipt-stability proof (same diff yields
// the identical receipt with and without context attached).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeDiff,
  formatHuman,
  toJson,
  withBlastContext,
  findingBlastContext,
  isTestPath,
  BLAST_CONTEXT_NOTE,
} from '../lib/review.js';
import { buildGraph } from '../lib/context-graph.js';
import { makeReceipt, verifyReceipt } from '../lib/receipt.js';

const EVAL_DIFF = `diff --git a/srv/app.js b/srv/app.js
index 1111111..2222222 100644
--- a/srv/app.js
+++ b/srv/app.js
@@ -1,3 +1,4 @@
 export function run(input) {
+  return eval(input);
 }
`;

function toyGraph() {
  return buildGraph([
    { path: 'srv/app.js', text: 'export function run(input) {\n  return eval(input);\n}\n' },
    { path: 'srv/cli.js', text: "import { run } from './app.js';\nrun(process.argv[2]);\n" },
    { path: 'test/app.test.js', text: "import { run } from '../srv/app.js';\nrun('x');\n" },
  ]);
}

async function blockingResult() {
  const { result, summary } = await analyzeDiff({
    diffText: EVAL_DIFF,
    pack: undefined,
    excludePatterns: [],
    resolutions: new Set(),
    headSha: 'abc123',
    baseSha: 'base',
  });
  assert.equal(result.verdict, 'DO_NOT_SHIP');
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0].file, 'srv/app.js');
  return { result, summary };
}

function snapshotOf(result) {
  return {
    blocking: result.blocking,
    silenced: result.silenced,
    nonBlocking: result.nonBlocking,
    excluded: result.excluded,
  };
}

function receiptFor(result, findings) {
  return makeReceipt({
    repo: 'o/r',
    prNumber: 1,
    headSha: result.headSha,
    baseSha: result.baseSha,
    rulePackVersion: result.rulePackVersion,
    verdict: result.verdict,
    findings,
    counts: {
      blocking: findings.blocking.length,
      silenced: findings.silenced.length,
      nonBlocking: findings.nonBlocking.length,
      excluded: findings.excluded.length,
    },
    configHash: null,
    source: 'manual',
    environment: null,
    prevReceiptId: null,
  });
}

test('findingBlastContext: top files, symbols, tests over a graph', () => {
  const ctx = findingBlastContext({ ruleId: 'r', file: 'srv/app.js', line: 2 }, toyGraph());
  assert.deepEqual(ctx.files, ['srv/app.js', 'srv/cli.js', 'test/app.test.js']);
  assert.deepEqual(ctx.symbols, ['run']);
  assert.deepEqual(ctx.tests, ['test/app.test.js']);
  assert.equal(ctx.truncated, false);
});

test('findingBlastContext: caps truncate deterministically', () => {
  const ctx = findingBlastContext({ ruleId: 'r', file: 'srv/app.js', line: 2 }, toyGraph(), { filesCap: 1, testsCap: 0 });
  assert.deepEqual(ctx.files, ['srv/app.js']);
  assert.deepEqual(ctx.tests, []);
  assert.equal(ctx.truncated, true);
});

test('findingBlastContext: unknown file yields empty lists, null graph yields null', () => {
  assert.deepEqual(
    findingBlastContext({ ruleId: 'r', file: 'nope/missing.js', line: 1 }, toyGraph()),
    { files: [], symbols: [], tests: [], truncated: false },
  );
  assert.equal(findingBlastContext({ ruleId: 'r', file: 'srv/app.js', line: 1 }, null), null);
  assert.equal(findingBlastContext(null, toyGraph()), null);
});

test('isTestPath: deterministic test-file heuristic', () => {
  assert.equal(isTestPath('test/app.test.js'), true);
  assert.equal(isTestPath('tests/unit/x.js'), true);
  assert.equal(isTestPath('src/x.spec.ts'), true);
  assert.equal(isTestPath('srv/app.js'), false);
  assert.equal(isTestPath('contest/app.js'), false);
});

test('withBlastContext: copies findings, never mutates inputs', async () => {
  const { result } = await blockingResult();
  const before = JSON.stringify(result.blocking);
  const attached = withBlastContext(result.blocking, toyGraph());
  assert.equal(JSON.stringify(result.blocking), before);
  assert.ok(!('blastContext' in result.blocking[0]));
  assert.deepEqual(attached[0].blastContext.files, ['srv/app.js', 'srv/cli.js', 'test/app.test.js']);
});

test('human + json carry labeled advisory context only when a graph is given', async () => {
  const { result, summary } = await blockingResult();
  const graph = toyGraph();
  const human = formatHuman(result, { summary, blastGraph: graph });
  assert.ok(human.includes('~ context (advisory, non-verdict): files(3): srv/app.js, srv/cli.js, test/app.test.js'));
  assert.ok(human.includes(`context: ${BLAST_CONTEXT_NOTE}`));
  const plain = formatHuman(result, { summary });
  assert.ok(!plain.includes('advisory'));
  assert.ok(!plain.includes('blastContext'));

  const json = toJson(result, { repo: 'o/r', prNumber: 1, summary, blastGraph: graph });
  assert.equal(json.contextNote, BLAST_CONTEXT_NOTE);
  assert.deepEqual(json.findings.blocking[0].blastContext.tests, ['test/app.test.js']);
  const plainJson = JSON.stringify(toJson(result, { repo: 'o/r', prNumber: 1, summary }));
  assert.ok(!plainJson.includes('blastContext'));
  assert.ok(!plainJson.includes('contextNote'));
});

test('receipt stability: identical receipt_id with and without blast context', async () => {
  const { result } = await blockingResult();
  const graph = toyGraph();
  const bare = receiptFor(result, snapshotOf(result));
  const attached = receiptFor(result, {
    blocking: withBlastContext(result.blocking, graph),
    silenced: withBlastContext(result.silenced, graph),
    nonBlocking: withBlastContext(result.nonBlocking, graph),
    excluded: withBlastContext(result.excluded, graph),
  });
  assert.equal(attached.receipt_id, bare.receipt_id);
  assert.ok(!JSON.stringify(attached.findings).includes('blastContext'));
  assert.deepEqual(verifyReceipt(attached), { valid: true });
  assert.deepEqual(verifyReceipt(bare), { valid: true });
});
