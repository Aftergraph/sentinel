import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createConsoleServer } from '../console/server.js';

const CLEAN_DIFF = `diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
`;

const EVAL_DIFF = `diff --git a/srv/app.js b/srv/app.js
index 1111111..2222222 100644
--- a/srv/app.js
+++ b/srv/app.js
@@ -1,3 +1,4 @@
 export function run(input) {
+  return eval(input);
 }
`;

async function boot(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-pr-'));
  const handler = createConsoleServer({
    ledgerPath: join(dir, 'ledger.jsonl'),
    memoryPath: join(dir, 'mem.jsonl'),
    // Hermetic: never discover cwd config (a stray file would poison results).
    configPath: join(dir, 'sentinel.config.json'),
    ...opts,
  });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    dir,
    async call(method, path, body, headers = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json() };
    },
    async text(path, headers = {}) {
      const res = await fetch(`${base}${path}`, { headers });
      return { status: res.status, body: await res.text() };
    },
    async close() {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('pr: record shape aggregates ledger findings with receipt id', async () => {
  const c = await boot();
  try {
    const posted = await c.call('POST', '/api/review', { diff: EVAL_DIFF, repo: 'o/r', pr: 3 });
    assert.equal(posted.status, 200);
    assert.equal(posted.json.verdict, 'DO_NOT_SHIP');

    // Encoded slash and bare-slash repo paths resolve to the same record.
    const enc = await c.call('GET', '/api/pr/o%2Fr/3');
    const bare = await c.call('GET', '/api/pr/o/r/3');
    assert.equal(enc.status, 200);
    assert.deepEqual(bare.json, enc.json);

    const p = enc.json;
    assert.deepEqual(Object.keys(p).sort(), [
      'activity', 'blocking', 'counts', 'evidence', 'headSha', 'nonBlocking',
      'prNumber', 'receipt', 'receiptId', 'repo', 'requestedHead',
      'rulePackVersion', 'silenced', 'stale', 'staleReason', 'verdict',
    ]);
    assert.equal(p.repo, 'o/r');
    assert.equal(p.prNumber, 3);
    assert.equal(p.headSha, posted.json.review.headSha);
    assert.equal(p.verdict, 'DO_NOT_SHIP');
    assert.equal(p.receiptId, posted.json.receipt.receipt_id);
    assert.equal(p.requestedHead, null);
    assert.equal(p.stale, false);
    assert.equal(p.staleReason, null);

    assert.ok(p.blocking.length >= 1);
    const f = p.blocking[0];
    assert.equal(f.ruleId, 'no-eval-with-dynamic-input');
    assert.equal(f.file, 'srv/app.js');
    assert.equal(typeof f.line, 'number');
    assert.ok(typeof f.evidence === 'string' && f.evidence.length > 0);
    // Review recomputation at serve time: severity + blocking re-derived.
    assert.equal(f.severity, 'security');
    assert.equal(f.blocking, true);
    // AI-confidence travels on its own key, apart from verification state.
    assert.ok('aiConfidence' in f);
    assert.ok('verificationState' in f);
    assert.ok(Array.isArray(p.nonBlocking));
    for (const g of p.nonBlocking) assert.equal(g.blocking, false);

    // Evidence list carries sealed ids + hashes; activity trails receipts.
    assert.ok(Array.isArray(p.evidence));
    for (const e of p.evidence) {
      assert.ok(typeof e.id === 'string' && e.id.length > 0);
      assert.ok(typeof e.hash === 'string' && e.hash.length > 0);
    }
    assert.equal(p.activity.length, 1);
    assert.equal(p.activity[0].type, 'receipt');
    assert.equal(p.activity[0].receiptId, p.receiptId);
    assert.equal(p.activity[0].verdict, 'DO_NOT_SHIP');
    assert.ok(p.activity[0].timestamp);
  } finally { await c.close(); }
});

test('pr: STALE flag follows requested head (head drift)', async () => {
  const H1 = 'a'.repeat(40);
  const H2 = 'b'.repeat(40);
  const c = await boot();
  try {
    const posted = await c.call('POST', '/api/review', { diff: CLEAN_DIFF, repo: 'o/r', pr: 4, headSha: H1 });
    assert.equal(posted.status, 200);
    assert.equal(posted.json.review.headSha, H1);

    // No requested head: no drift, no STALE flag.
    const plain = await c.call('GET', '/api/pr/o%2Fr/4');
    assert.equal(plain.json.stale, false);
    assert.equal(plain.json.requestedHead, null);

    // Matching head: fresh.
    const same = await c.call('GET', `/api/pr/o%2Fr/4?head=${H1}`);
    assert.equal(same.status, 200);
    assert.equal(same.json.stale, false);
    assert.equal(same.json.requestedHead, H1);

    // Drifted head: STALE with a reason naming both sides.
    const drift = await c.call('GET', `/api/pr/o%2Fr/4?head=${H2}`);
    assert.equal(drift.status, 200);
    assert.equal(drift.json.stale, true);
    assert.equal(drift.json.requestedHead, H2);
    assert.ok(drift.json.staleReason.includes(H2));
    assert.ok(drift.json.staleReason.includes(H1));
    // The record itself is unchanged — only the flag flips.
    assert.equal(drift.json.headSha, H1);
    assert.equal(drift.json.verdict, 'SHIP');
  } finally { await c.close(); }
});

test('pr: activity grows across reviews of the same repo+pr', async () => {
  const c = await boot();
  try {
    await c.call('POST', '/api/review', { diff: CLEAN_DIFF, repo: 'o/r', pr: 5, headSha: 'a'.repeat(40) });
    await c.call('POST', '/api/review', { diff: EVAL_DIFF, repo: 'o/r', pr: 5, headSha: 'b'.repeat(40) });
    const { status, json } = await c.call('GET', '/api/pr/o%2Fr/5');
    assert.equal(status, 200);
    assert.equal(json.activity.length, 2);
    assert.deepEqual(json.activity.map((a) => a.seq), [1, 2]);
    assert.equal(json.headSha, 'b'.repeat(40));
    assert.equal(json.verdict, 'DO_NOT_SHIP');
  } finally { await c.close(); }
});

test('pr: unknown PR 404s, malformed path 400s', async () => {
  const c = await boot();
  try {
    assert.equal((await c.call('GET', '/api/pr/no%2Fpe/9')).status, 404);
    assert.equal((await c.call('GET', '/api/pr/onlyrepo')).status, 400);
    assert.equal((await c.call('GET', '/api/pr')).status, 400);
  } finally { await c.close(); }
});

test('pr: token gate enforced on the new route', async () => {
  const c = await boot({ token: 'tok' });
  try {
    await c.call('POST', '/api/review', { diff: CLEAN_DIFF, repo: 'o/r', pr: 1 }, { authorization: ['Bearer', 'tok'].join(' ') });
    assert.equal((await c.call('GET', '/api/pr/o%2Fr/1')).status, 401);
    const authed = await c.call('GET', '/api/pr/o%2Fr/1', undefined, { authorization: ['Bearer', 'tok'].join(' ') });
    assert.equal(authed.status, 200);
    assert.equal(authed.json.repo, 'o/r');
    assert.equal(typeof authed.json.stale, 'boolean');
  } finally { await c.close(); }
});

test('pr: brand-law tokens and tab semantics in served output', async () => {
  const c = await boot();
  try {
    const page = await c.text('/');
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('#/pr'));

    const js = await c.text('/app.js');
    assert.equal(js.status, 200);
    assert.ok(js.body.includes('/api/pr/'));
    // Four tabs with WAI-ARIA tab semantics.
    for (const label of ['Overview', 'Findings', 'Evidence', 'Activity']) {
      assert.ok(js.body.includes(label), `missing tab ${label}`);
    }
    assert.ok(js.body.includes('role="tablist"'));
    assert.ok(js.body.includes('role="tab"'));
    assert.ok(js.body.includes('role="tabpanel"'));
    assert.ok(js.body.includes('aria-selected'));
    assert.ok(js.body.includes('aria-controls'));
    // Keyboard navigable: arrows/Home/End plus native Tab focus.
    assert.ok(js.body.includes('ArrowRight'));
    assert.ok(js.body.includes('ArrowLeft'));
    // Findings: severity icon+label+text; AI-confidence apart from verification.
    assert.ok(js.body.includes('AI confidence'));
    assert.ok(js.body.includes('Verification:'));
    assert.ok(js.body.includes('model estimate, not evidence'));
    assert.ok(js.body.includes('aria-label="severity'));
    // Brand law: purple AI accent, icon+label verdict pills (never color-only).
    assert.ok(js.body.includes('pr-ai') || js.body.includes('var(--purple)'));
    assert.ok(js.body.includes('● SHIP'));
    assert.ok(js.body.includes('● DO NOT SHIP'));
    assert.ok(js.body.includes('◐ STALE'));
    for (const re of [/color\s*:\s*red/i, /color\s*:\s*green/i, /color\s*:\s*orange/i, /background\s*:\s*red/i, /background\s*:\s*green/i]) {
      assert.ok(!re.test(js.body), `color-only verdict styling: ${re}`);
    }

    const css = await c.text('/styles.css');
    assert.equal(css.status, 200);
    assert.ok(css.body.includes('--purple'));
    assert.ok(css.body.includes('--green'));
    assert.ok(css.body.includes('--red'));
    assert.ok(css.body.includes('--orange'));
    assert.ok(css.body.includes('--gray'));
    assert.ok(css.body.includes('.tabs'));
    assert.ok(css.body.includes('.pr-ai'));
    assert.ok(css.body.includes('.stale-banner'));
    assert.ok(css.body.includes('@media (prefers-reduced-motion: reduce)'));
  } finally { await c.close(); }
});
