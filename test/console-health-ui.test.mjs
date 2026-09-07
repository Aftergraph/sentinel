import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import vm from 'node:vm';
import { createConsoleServer } from '../console/server.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-health-ui-'));
  const ledgerPath = opts.ledgerPath || join(dir, 'ledger.jsonl');
  const handler = createConsoleServer({
    ledgerPath,
    memoryPath: opts.memoryPath || join(dir, 'mem.jsonl'),
    configPath: opts.configPath || join(dir, 'sentinel.config.json'),
    ...(opts.token ? { token: opts.token } : {}),
  });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    dir,
    ledgerPath,
    async call(method, path, body, headers = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json() };
    },
    async raw(path) {
      const res = await fetch(`${base}${path}`);
      return { status: res.status, text: await res.text() };
    },
    async close() {
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// The served esc() extracted from app.js and executed in a sandbox, so
// escaping claims below hold for the shipped code, not a copy of it.
function servedEsc(appJs) {
  const m = appJs.match(/const esc = .*?;\r?\n/);
  assert.ok(m, 'served app.js must define const esc');
  return vm.runInNewContext(`${m[0]}esc`);
}

test('health UI: shell carries health + integrity nav and view markers', async () => {
  const c = await boot();
  try {
    const html = await c.raw('/');
    assert.equal(html.status, 200);
    assert.ok(html.text.includes('#/health'), 'nav links to #/health');
    assert.ok(html.text.includes('#/integrity'), 'nav links to #/integrity');

    const js = await c.raw('/app.js');
    assert.equal(js.status, 200);
    for (const marker of [
      'vHealth', 'vIntegrity',
      '/api/health/verdicts', '/api/ledger/verify',
      'setInterval', 'stopHealthPoll', 'stopIntegrityPoll',
      'Top blocking rules', 'Ledger integrity',
      'Chain OK', 'Chain FAILED',
      'No verdicts recorded yet',
      'No blocking rules recorded yet',
      'aria-label="Verdict totals"',
      '<h2>Health</h2>', '<h2>Integrity</h2>',
    ]) {
      assert.ok(js.text.includes(marker), `served app.js must contain: ${marker}`);
    }
    // Totals render all five verdict keys with icon+label (never color-only).
    for (const key of ['SHIP', 'DO_NOT_SHIP', 'STALE', 'BLOCKED', 'OVERRIDDEN']) {
      assert.ok(js.text.includes(`'${key}'`), `health cards must cover ${key}`);
    }
    // Integrity panel lists bad receipt ids, never a raw ledger dump: the
    // new health/integrity code slice touches only the aggregate routes.
    const start = js.text.indexOf('// Health dashboard + ledger-integrity views');
    const end = js.text.indexOf('// Verification-run view');
    assert.ok(start !== -1 && end > start, 'health/integrity block must be delimited');
    const slice = js.text.slice(start, end);
    assert.ok(slice.includes('/api/health/verdicts') && slice.includes('/api/ledger/verify'));
    assert.ok(!slice.includes('/api/ledger?'), 'health/integrity code must not pull raw receipts');
  } finally { await c.close(); }
});

test('health UI: served esc() escapes seeded rule ids, receipt ids, counts', async () => {
  const c = await boot();
  try {
    // Seed: post a review so a real rule id flows through the data routes.
    const dirty = await c.call('POST', '/api/review', { diff: EVAL_DIFF, repo: 'block/repo', pr: 2 });
    assert.equal(dirty.status, 200);
    const { json: h } = await c.call('GET', '/api/health/verdicts');
    const top = h.byRule.find((e) => e.ruleId === 'no-eval-with-dynamic-input');
    assert.ok(top, 'seeded blocking rule must appear in byRule');
    assert.ok(top.count >= 1);

    const jsText = (await c.raw('/app.js')).text;
    // Rendering paths pass rule ids, bad ids and counts through esc().
    assert.match(jsText, /esc\([^)]*ruleId/, 'rule ids render via esc()');
    assert.match(jsText, /esc\(id\)/, 'bad receipt ids render via esc()');
    assert.match(jsText, /esc\(String\(/, 'counts render as escaped numbers');

    const esc = servedEsc(jsText);
    // Seeded rule id passes through unchanged (no metacharacters to alter).
    assert.equal(esc(top.ruleId), 'no-eval-with-dynamic-input');
    // Hostile values that could arrive via repo/receipt fields are neutralized.
    assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(esc('a"b&c<d>'), 'a&quot;b&amp;c&lt;d&gt;');
    assert.equal(esc(String(top.count)), String(top.count));
    assert.equal(esc(dirty.json.receipt.receipt_id), dirty.json.receipt.receipt_id);
    assert.equal(esc('"><script>alert(1)</script>'), '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  } finally { await c.close(); }
});

test('health UI: empty-ledger zero state; integrity shapes; no new routes', async () => {
  const c = await boot();
  try {
    // Empty ledger: zeros, and the served JS holds the matching zero state.
    const empty = await c.call('GET', '/api/health/verdicts');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.totals, { SHIP: 0, DO_NOT_SHIP: 0, STALE: 0, BLOCKED: 0, OVERRIDDEN: 0 });
    assert.deepEqual(empty.json.byRule, []);
    const jsText = (await c.raw('/app.js')).text;
    assert.ok(jsText.includes('No verdicts recorded yet'), 'empty-state text served in JS');

    // Seeded shapes behind the views.
    await c.call('POST', '/api/review', { diff: EVAL_DIFF, repo: 'block/repo', pr: 2 });
    const h = await c.call('GET', '/api/health/verdicts');
    assert.deepEqual(Object.keys(h.json).sort(), ['byRule', 'policyOverrides', 'totals', 'window']);
    const v = await c.call('GET', '/api/ledger/verify');
    assert.equal(v.json.ok, true);
    assert.equal(typeof v.json.checked, 'number');

    // No new routes: guessed paths under both prefixes still 404.
    assert.equal((await c.call('GET', '/api/health/nope')).status, 404);
    assert.equal((await c.call('GET', '/api/health/verdicts/deep')).status, 404);
    assert.equal((await c.call('GET', '/api/ledger/verify/extra')).status, 404);
    assert.equal((await c.call('GET', '/api/ledger/deep')).status, 404);
  } finally { await c.close(); }
});

test('health UI: tampered chain surfaces bad ids for the integrity panel', async () => {
  const c1 = await boot();
  let c2 = null;
  try {
    const clean = await c1.call('POST', '/api/review', { diff: EVAL_DIFF, repo: 'ship/repo', pr: 1 });
    assert.equal(clean.status, 200);
    const receiptId = clean.json.receipt.receipt_id;

    const lines = readFileSync(c1.ledgerPath, 'utf8').split('\n').filter((l) => l.trim());
    const rec = JSON.parse(lines[0]);
    rec.verdict = rec.verdict === 'SHIP' ? 'DO_NOT_SHIP' : 'SHIP';
    lines[0] = JSON.stringify(rec);
    writeFileSync(c1.ledgerPath, `${lines.join('\n')}\n`);

    c2 = await boot({ ledgerPath: c1.ledgerPath });
    const tampered = await c2.call('GET', '/api/ledger/verify');
    assert.equal(tampered.json.ok, false);
    assert.ok(tampered.json.bad.includes(receiptId));

    // The served esc() renders that bad id without markup breakout.
    const esc = servedEsc((await c2.raw('/app.js')).text);
    assert.equal(esc(receiptId), receiptId);
    assert.ok(!esc(receiptId).includes('<'));
  } finally {
    if (c2) await c2.close();
    await c1.close();
  }
});
