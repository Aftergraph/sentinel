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
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-overview-'));
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

test('overview: shape and counts match fixture math', async () => {
  const c = await boot({ repos: ['flag/plain'] });
  try {
    const clean = await c.call('POST', '/api/review', { diff: CLEAN_DIFF, repo: 'ship/repo', pr: 1 });
    assert.equal(clean.status, 200);
    assert.equal(clean.json.verdict, 'SHIP');
    const dirty = await c.call('POST', '/api/review', { diff: EVAL_DIFF, repo: 'block/repo', pr: 7 });
    assert.equal(dirty.status, 200);
    assert.equal(dirty.json.verdict, 'DO_NOT_SHIP');
    const blockingCount = dirty.json.findings.blocking.length;
    assert.ok(blockingCount >= 1);

    const { status, json } = await c.call('GET', '/api/overview');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(json).sort(), [
      'blocked', 'confidence', 'critical', 'needsAttention', 'open', 'recentVerdicts', 'stale',
    ]);
    assert.equal(json.open, 3);
    assert.equal(json.blocked, 1);
    assert.equal(json.stale, 0);
    assert.equal(json.critical, blockingCount);
    // 1 SHIP of 2 verdict-bearing repos.
    assert.equal(json.confidence, 0.5);

    assert.equal(json.needsAttention.length, 2);
    assert.deepEqual(json.needsAttention.map((q) => q.repo), ['block/repo', 'flag/plain']);
    const blockedQ = json.needsAttention[0];
    assert.equal(blockedQ.reason, 'blocked');
    assert.equal(blockedQ.verdict, 'DO_NOT_SHIP');
    assert.ok(blockedQ.receiptId);
    assert.equal(json.needsAttention[1].reason, 'no-verdict');
    assert.equal(json.needsAttention[1].verdict, null);

    assert.equal(json.recentVerdicts.length, 2);
    assert.equal(json.recentVerdicts[0].repo, 'block/repo');
    assert.equal(json.recentVerdicts[0].verdict, 'DO_NOT_SHIP');
    assert.ok(json.recentVerdicts[0].receiptId);
    assert.ok(json.recentVerdicts[0].timestamp);
    assert.equal(json.recentVerdicts[1].repo, 'ship/repo');
  } finally { await c.close(); }
});

test('overview: empty ledger reports open flags with full confidence', async () => {
  const c = await boot({ repos: ['flag/plain'] });
  try {
    const { status, json } = await c.call('GET', '/api/overview');
    assert.equal(status, 200);
    assert.equal(json.open, 1);
    assert.equal(json.blocked, 0);
    assert.equal(json.stale, 0);
    assert.equal(json.critical, 0);
    assert.equal(json.confidence, 1);
    assert.deepEqual(json.needsAttention.map((q) => q.reason), ['no-verdict']);
    assert.deepEqual(json.recentVerdicts, []);
  } finally { await c.close(); }
});

test('overview: stale verdicts counted from the ledger', async () => {
  const H1 = 'a'.repeat(40);
  const H2 = 'b'.repeat(40);
  let n = 0;
  const platform = {
    async getPR() { return { head: { sha: [H1, H2][Math.min(n++, 1)] }, base: { sha: 'c'.repeat(40) } }; },
    async getDiff() { return CLEAN_DIFF; },
  };
  const c = await boot({ platform });
  try {
    const r = await c.call('POST', '/api/review', { repo: 'o/r', pr: 4 });
    assert.equal(r.json.verdict, 'STALE');
    const { json } = await c.call('GET', '/api/overview');
    assert.equal(json.open, 1);
    assert.equal(json.stale, 1);
    assert.equal(json.blocked, 0);
    assert.equal(json.confidence, 0);
    assert.equal(json.needsAttention[0].reason, 'stale');
    assert.equal(json.needsAttention[0].verdict, 'STALE');
  } finally { await c.close(); }
});

test('overview: brand-law tokens served, verdicts never color-only', async () => {
  const c = await boot();
  try {
    const page = await c.text('/');
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('Sentinel Console'));
    assert.ok(page.body.includes('#/overview'));
    assert.ok(page.body.includes('Overview'));

    const js = await c.text('/app.js');
    assert.equal(js.status, 200);
    assert.ok(js.body.includes('/api/overview'));
    // Brand-law tokens: purple inference accent + pill verdicts (icon+label+text).
    assert.ok(js.body.includes('var(--purple)') || js.body.includes('ov-confidence'));
    assert.ok(js.body.includes('● SHIP'));
    assert.ok(js.body.includes('● DO NOT SHIP'));
    assert.ok(js.body.includes('● STALE'));
    // Overview cards are keyboard-focusable semantic articles.
    assert.ok(js.body.includes('tabindex="0"'));
    assert.ok(js.body.includes('<article'));
    assert.ok(js.body.includes('<section'));
    for (const label of ['Open', 'Blocked', 'Stale', 'Critical']) {
      assert.ok(js.body.includes(label), `missing card ${label}`);
    }
    // No raw color-only verdict styling in served JS.
    for (const re of [/color\s*:\s*red/i, /color\s*:\s*green/i, /color\s*:\s*orange/i, /background\s*:\s*red/i, /background\s*:\s*green/i]) {
      assert.ok(!re.test(js.body), `color-only verdict styling: ${re}`);
    }

    const css = await c.text('/styles.css');
    assert.equal(css.status, 200);
    assert.ok(css.body.includes('--purple'));
    assert.ok(css.body.includes('@media (prefers-reduced-motion: reduce)'));
  } finally { await c.close(); }
});

test('overview: token gate enforced on the new route', async () => {
  const c = await boot({ token: 'tok' });
  try {
    assert.equal((await c.call('GET', '/api/overview')).status, 401);
    const authed = await c.call('GET', '/api/overview', undefined, { authorization: 'Bearer tok' });
    assert.equal(authed.status, 200);
    assert.ok(typeof authed.json.confidence === 'number');
    assert.ok(Array.isArray(authed.json.needsAttention));
    assert.ok(Array.isArray(authed.json.recentVerdicts));
  } finally { await c.close(); }
});
