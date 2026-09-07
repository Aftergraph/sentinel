import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECEIPT_CONTRACT, SOURCE_ENUM, detectSource, receiptIdFor, makeReceipt,
  verifyReceipt, appendLedger, loadLedger, latestForRepoPr,
} from '../lib/receipt.js';
import {
  computeVerdict, summarizeDiff, computeDelta, globToRegExp, filterExcluded,
  loadConfig, toGov, formatHuman,
} from '../lib/review.js';
import { RULE_PACK_VERSION } from '../lib/rulepack.js';

function snap(blocking = [], extra = {}) {
  return {
    blocking, silenced: [], nonBlocking: [], excluded: [],
    ...extra,
  };
}

function baseInput(over = {}) {
  return {
    repo: 'o/r',
    prNumber: 7,
    headSha: 'h'.repeat(40),
    baseSha: 'b'.repeat(40),
    rulePackVersion: RULE_PACK_VERSION,
    verdict: 'DO_NOT_SHIP',
    findings: snap([{ ruleId: 'no-eval-with-dynamic-input', file: 'a.js', line: 1, evidence: 'eval(x)' }]),
    counts: { blocking: 1, silenced: 0, nonBlocking: 0, excluded: 0 },
    configHash: null,
    source: 'manual',
    environment: { runner: 'test', versions: { node: 'v20', sentinel: '0.1.0', rulepack: RULE_PACK_VERSION } },
    prevReceiptId: null,
    runId: 'fixed-run-id',
    timestamp: '2026-09-07T00:00:00.000Z',
    ...over,
  };
}

test('receipt: identical inputs yield identical ids (idempotent)', () => {
  const a = makeReceipt(baseInput());
  const b = makeReceipt(baseInput());
  assert.equal(a.receipt_id, b.receipt_id);
  assert.match(a.receipt_id, /^[a-f0-9]{64}$/);
});

test('receipt: different findings yield different ids', () => {
  const a = makeReceipt(baseInput());
  const c = makeReceipt(baseInput({ findings: snap([]), counts: { blocking: 0, silenced: 0, nonBlocking: 0, excluded: 0 }, verdict: 'SHIP' }));
  assert.notEqual(a.receipt_id, c.receipt_id);
});

test('receipt: verify round-trips, tampering fails', () => {
  const r = makeReceipt(baseInput());
  assert.deepEqual(verifyReceipt(r), { valid: true });
  assert.equal(verifyReceipt({ ...r, verdict: 'SHIP' }).valid, false);
  assert.match(verifyReceipt({ ...r, verdict: 'SHIP' }).reason, /mismatch/);
  const { receipt_id, ...rest } = r;
  assert.match(verifyReceipt(rest).reason, /missing field: receipt_id/);
  assert.match(verifyReceipt({ ...r, contract: 'bogus/9.9' }).reason, /unknown contract/);
  assert.equal(verifyReceipt(null).valid, false);
});

test('ledger: append, chain, latest, skips malformed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ledger-'));
  try {
    const p = join(dir, 'ledger.jsonl');
    const r1 = appendLedger(makeReceipt(baseInput()), p);
    const r2 = appendLedger(makeReceipt(baseInput({ prevReceiptId: r1.receipt_id, runId: 'run-2' })), p);
    writeFileSync(p, 'not json\n', { flag: 'a' });
    const entries = loadLedger(p);
    assert.equal(entries.length, 2);
    assert.equal(r2.prev_receipt_id, r1.receipt_id);
    assert.equal(latestForRepoPr(entries, 'o/r', 7).receipt_id, r2.receipt_id);
    assert.equal(latestForRepoPr(entries, 'o/other', 7), null);
    assert.deepEqual(loadLedger(join(dir, 'missing.jsonl')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source: enum + env detection', () => {
  assert.ok(SOURCE_ENUM.includes('manual'));
  assert.ok(SOURCE_ENUM.includes('github-actions'));
  const saved = process.env.GITHUB_ACTIONS;
  try {
    process.env.GITHUB_ACTIONS = 'true';
    assert.equal(detectSource(), 'github-actions');
    delete process.env.GITHUB_ACTIONS;
    assert.equal(detectSource(), 'manual');
  } finally {
    if (saved === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = saved;
  }
});

test('summarizeDiff: files, added, removed, top', () => {
  const diff = `diff --git a/a.js b/a.js
index 1111111..2222222 100644
--- a/a.js
+++ b/a.js
@@ -1,3 +1,5 @@
 ctx
+one
+two
-old
 ctx2
diff --git a/b.sql b/b.sql
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/b.sql
@@ -0,0 +1 @@
+SELECT 1;
`;
  const s = summarizeDiff(diff);
  assert.equal(s.files, 2);
  assert.equal(s.added, 3);
  assert.equal(s.removed, 1);
  assert.equal(s.top[0].path, 'a.js');
  assert.deepEqual(summarizeDiff(''), { files: 0, added: 0, removed: 0, top: [] });
});

test('computeDelta: new, fixed, carried', () => {
  const f1 = { ruleId: 'r1', file: 'a.js', line: 1, evidence: 'e1' };
  const f2 = { ruleId: 'r2', file: 'b.js', line: 2, evidence: 'e2' };
  const f3 = { ruleId: 'r3', file: 'c.js', line: 3, evidence: 'e3' };
  const d = computeDelta([f1, f2], [f2, f3]);
  assert.equal(d.new.length, 1);
  assert.equal(d.new[0].ruleId, 'r3');
  assert.equal(d.fixed.length, 1);
  assert.equal(d.fixed[0].ruleId, 'r1');
  assert.equal(d.carried, 1);
  assert.deepEqual(computeDelta([], []), { new: [], fixed: [], carried: 0 });
});

test('globs: **, *, ? semantics', () => {
  assert.ok(globToRegExp('docs/**').test('docs/a/b.md'));
  assert.ok(!globToRegExp('docs/*.md').test('docs/a/b.md'));
  assert.ok(globToRegExp('docs/*.md').test('docs/b.md'));
  assert.ok(globToRegExp('src/?.js').test('src/a.js'));
  assert.ok(!globToRegExp('src/?.js').test('src/ab.js'));
  const { included, excluded } = filterExcluded(
    [{ ruleId: 'x', file: 'docs/guide.md' }, { ruleId: 'y', file: 'src/a.js' }],
    ['docs/**'],
  );
  assert.equal(excluded.length, 1);
  assert.equal(included.length, 1);
  assert.deepEqual(filterExcluded([{ ruleId: 'x' }], []).excluded, []);
});

test('loadConfig: missing, valid, and fail-closed shapes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-cfg-'));
  try {
    const missing = loadConfig(join(dir, 'nope.json'));
    assert.deepEqual(missing.config, { rulePack: null, exclude: [] });
    assert.equal(missing.configHash, null);

    const good = join(dir, 'sentinel.config.json');
    writeFileSync(good, JSON.stringify({ rulePack: '1.0.0', exclude: ['docs/**'] }));
    const loaded = loadConfig(good);
    assert.equal(loaded.config.rulePack, '1.0.0');
    assert.deepEqual(loaded.config.exclude, ['docs/**']);
    assert.match(loaded.configHash, /^[a-f0-9]{16}$/);

    const badKey = join(dir, 'bad1.json');
    writeFileSync(badKey, JSON.stringify({ severity: 'low' }));
    assert.throws(() => loadConfig(badKey), /unknown key/);

    const badPack = join(dir, 'bad2.json');
    writeFileSync(badPack, JSON.stringify({ rulePack: '9.9' }));
    assert.throws(() => loadConfig(badPack), /rulePack/);

    const badEx = join(dir, 'bad3.json');
    writeFileSync(badEx, JSON.stringify({ exclude: 'docs/**' }));
    assert.throws(() => loadConfig(badEx), /exclude/);

    const badJson = join(dir, 'bad4.json');
    writeFileSync(badJson, '{nope');
    assert.throws(() => loadConfig(badJson), /not JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('toGov: per-rule results plus verdict entry', () => {
  const fired = { ruleId: 'no-eval-with-dynamic-input', file: 'a.js', line: 1, evidence: 'eval(x)' };
  const res = computeVerdict([fired], new Set(), {
    headSha: 'h'.repeat(40), baseSha: 'b'.repeat(40), rulePackVersion: RULE_PACK_VERSION,
  });
  const gov = toGov(res, { repo: 'o/r', prNumber: 7, source: 'manual', environment: { runner: 't', versions: {} }, runId: 'r1' });
  assert.equal(gov.sha, 'h'.repeat(40));
  assert.equal(gov.results.length, 21);
  const byCtx = Object.fromEntries(gov.results.map((r) => [r.context, r.status]));
  assert.equal(byCtx['sentinel/no-eval-with-dynamic-input'], 'failure');
  assert.equal(byCtx['sentinel/no-var-instead-of-let-const'], 'success');
  assert.equal(byCtx['sentinel/verdict'], 'failure');

  const ship = computeVerdict([], new Set(), {
    headSha: 'h'.repeat(40), baseSha: 'b'.repeat(40), rulePackVersion: RULE_PACK_VERSION,
  });
  const govShip = toGov(ship, { repo: 'o/r', prNumber: 7, source: 'manual', environment: null, runId: 'r2' });
  assert.equal(govShip.results.at(-1).status, 'success');
});

test('toGov: STALE maps to a single cancelled entry', () => {
  const stale = {
    verdict: 'STALE', headSha: 'h'.repeat(40), baseSha: 'b'.repeat(40),
    rulePackVersion: RULE_PACK_VERSION, blocking: [], silenced: [], nonBlocking: [], excluded: [], checksPassed: 20,
  };
  const gov = toGov(stale, { repo: 'o/r', prNumber: 7, source: 'manual', environment: null, runId: 'r3' });
  assert.deepEqual(gov.results, [{ context: 'sentinel/review', status: 'cancelled' }]);
});

test('formatHuman: summary, delta, receipt, excluded, stale', () => {
  const res = computeVerdict(
    [{ ruleId: 'no-eval-with-dynamic-input', file: 'a.js', line: 1, evidence: 'eval(x)' }],
    new Set(),
    { headSha: 'H', baseSha: 'B', rulePackVersion: RULE_PACK_VERSION },
    [{ ruleId: 'no-var-instead-of-let-const', file: 'docs/x.js', line: 2, evidence: 'var a;' }],
  );
  const out = formatHuman(res, {
    summary: { files: 2, added: 10, removed: 3, top: [{ path: 'a.js', added: 9, removed: 1 }] },
    delta: { prevHeadSha: 'abcdef123456', new: res.blocking, fixed: [], carried: 0 },
    receipt: { receipt_id: 'deadbeef' },
  });
  assert.ok(out.includes('PR: 2 file(s), +10/-3'));
  assert.ok(out.includes('Since abcdef1: +1 new, -0 fixed'));
  assert.ok(out.includes('Excluded by config: 1'));
  assert.ok(out.includes('receipt: deadbeef'));

  const staleOut = formatHuman(
    { verdict: 'STALE', headSha: 'H', blocking: [], silenced: [], checksPassed: 20 },
    { staleReason: 'head moved from a to b' },
  );
  assert.ok(staleOut.includes('STALE — head moved from a to b'));
});

test('receipt contract id is pinned', () => {
  assert.equal(RECEIPT_CONTRACT, 'sentinel.receipt/0.1');
  assert.equal(receiptIdFor({ a: 1 }).length, 64);
});
