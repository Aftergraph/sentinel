import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-health-'));
  const ledgerPath = opts.ledgerPath || join(dir, 'ledger.jsonl');
  const handler = createConsoleServer({
    ledgerPath,
    memoryPath: opts.memoryPath || join(dir, 'mem.jsonl'),
    // Hermetic: never discover cwd config (a stray file would poison results).
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
    async close() {
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('health/verdicts + ledger/verify: empty ledger zeros, never throws', async () => {
  const c = await boot();
  try {
    const h = await c.call('GET', '/api/health/verdicts');
    assert.equal(h.status, 200);
    assert.deepEqual(h.json.totals, { SHIP: 0, DO_NOT_SHIP: 0, STALE: 0, BLOCKED: 0, OVERRIDDEN: 0 });
    assert.deepEqual(h.json.byRule, []);
    assert.equal(h.json.policyOverrides, 0);
    assert.deepEqual(h.json.window, { receipts: 0, since: null });

    const v = await c.call('GET', '/api/ledger/verify');
    assert.equal(v.status, 200);
    assert.deepEqual(v.json, { ok: true, checked: 0 });
  } finally { await c.close(); }
});

test('health/verdicts: seeded-ledger math over two reviews', async () => {
  const c = await boot();
  try {
    const clean = await c.call('POST', '/api/review', { diff: CLEAN_DIFF, repo: 'ship/repo', pr: 1 });
    assert.equal(clean.status, 200);
    assert.equal(clean.json.verdict, 'SHIP');
    const dirty = await c.call('POST', '/api/review', { diff: EVAL_DIFF, repo: 'block/repo', pr: 2 });
    assert.equal(dirty.status, 200);
    assert.equal(dirty.json.verdict, 'DO_NOT_SHIP');

    const { status, json } = await c.call('GET', '/api/health/verdicts');
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(json).sort(), ['byRule', 'policyOverrides', 'totals', 'window']);
    assert.equal(json.totals.SHIP, 1);
    assert.equal(json.totals.DO_NOT_SHIP, 1);
    assert.equal(json.totals.STALE, 0);
    assert.equal(json.totals.BLOCKED, 0);
    assert.equal(json.totals.OVERRIDDEN, 0);
    assert.equal(json.policyOverrides, 0);
    assert.equal(json.window.receipts, 2);
    assert.equal(typeof json.window.since, 'string');
    const top = json.byRule.find((e) => e.ruleId === 'no-eval-with-dynamic-input');
    assert.ok(top, 'expected blocking rule in byRule');
    assert.ok(top.count >= 1);

    // Standard repo filter narrows server-side counts.
    const filtered = await c.call('GET', '/api/health/verdicts?repo=ship/repo');
    assert.equal(filtered.status, 200);
    assert.equal(filtered.json.totals.SHIP, 1);
    assert.equal(filtered.json.totals.DO_NOT_SHIP, 0);
    assert.equal(filtered.json.window.receipts, 1);

    // Garbage filter types fail closed with 400.
    assert.equal((await c.call('GET', '/api/health/verdicts?pr=notanint')).status, 400);
    assert.equal((await c.call('GET', '/api/health/verdicts?repo=%20%20')).status, 400);
    assert.equal((await c.call('GET', '/api/ledger/verify?pr=abc')).status, 400);

    const v = await c.call('GET', '/api/ledger/verify');
    assert.equal(v.status, 200);
    assert.equal(v.json.ok, true);
    assert.equal(v.json.checked, 2);
  } finally { await c.close(); }
});

test('ledger/verify: tampered ledger file reports ok:false with bad id', async () => {
  const c1 = await boot();
  let c2 = null;
  try {
    const clean = await c1.call('POST', '/api/review', { diff: CLEAN_DIFF, repo: 'ship/repo', pr: 1 });
    assert.equal(clean.status, 200);
    const receiptId = clean.json.receipt.receipt_id;
    assert.ok(receiptId);

    const before = await c1.call('GET', '/api/ledger/verify');
    assert.equal(before.json.ok, true);

    // Tamper mid-test: flip the verdict without updating receipt_id so the
    // hash chain no longer recomputes.
    const lines = readFileSync(c1.ledgerPath, 'utf8').split('\n').filter((l) => l.trim());
    assert.ok(lines.length >= 1);
    const rec = JSON.parse(lines[0]);
    rec.verdict = rec.verdict === 'SHIP' ? 'DO_NOT_SHIP' : 'SHIP';
    lines[0] = JSON.stringify(rec);
    writeFileSync(c1.ledgerPath, `${lines.join('\n')}\n`);

    // Fresh boot over the same ledger file must see the tamper (no cache).
    c2 = await boot({ ledgerPath: c1.ledgerPath });
    const tampered = await c2.call('GET', '/api/ledger/verify');
    assert.equal(tampered.status, 200);
    assert.equal(tampered.json.ok, false);
    assert.ok(Array.isArray(tampered.json.bad));
    assert.ok(tampered.json.bad.includes(receiptId), `bad should include ${receiptId}`);

    // Health still answers 200 over a tampered ledger (never throws).
    const h = await c2.call('GET', '/api/health/verdicts');
    assert.equal(h.status, 200);
    assert.equal(h.json.window.receipts, lines.length);
  } finally {
    if (c2) await c2.close();
    await c1.close();
  }
});

test('health/verdicts + ledger/verify: token gate 401 without auth, 200 with', async () => {
  const token = `health-gate-${Date.now()}`;
  const c = await boot({ token });
  try {
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await c.call('GET', '/api/health/verdicts')).status, 401);
    assert.equal((await c.call('GET', '/api/ledger/verify')).status, 401);
    assert.equal((await c.call('GET', '/api/health/verdicts', undefined, auth)).status, 200);
    const v = await c.call('GET', '/api/ledger/verify', undefined, auth);
    assert.equal(v.status, 200);
    assert.equal(v.json.ok, true);
  } finally { await c.close(); }
});
