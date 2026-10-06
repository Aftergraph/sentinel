import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createConsoleServer } from '../console/server.js';
import { createCapabilityAttestationStore } from '../lib/capability-attestation-store.js';
import { makeReceipt, appendLedger } from '../lib/receipt.js';
import { RULE_PACK_VERSION, ruleIdsForPack } from '../lib/rulepack.js';

const EVAL_DIFF = `diff --git a/srv/app.js b/srv/app.js
index 1111111..2222222 100644
--- a/srv/app.js
+++ b/srv/app.js
@@ -1,3 +1,4 @@
 export function run(input) {
+  return eval(input);
 }
`;

const CLEAN_DIFF = `diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
`;

async function boot(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-console-'));
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
  const raw = (method, path, headers) => fetch(`${base}${path}`, { method, headers });
  return {
    dir,
    raw,
    async call(method, path, body, headers = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json() };
    },
    async close() {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('console: healthz reports version and pack', async () => {
  const c = await boot();
  try {
    const { status, json } = await c.call('GET', '/api/healthz');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.pack, RULE_PACK_VERSION);
  } finally { await c.close(); }
});

test('console: repos unions flags and ledger', async () => {
  const c = await boot({ repos: ['flagged/repo'] });
  try {
    let r = await c.call('GET', '/api/repos');
    assert.deepEqual(r.json.repos, [{ repo: 'flagged/repo' }]);
    await c.call('POST', '/api/review', { diff: CLEAN_DIFF, repo: 'led/ger', pr: 1 });
    r = await c.call('GET', '/api/repos');
    assert.equal(r.json.repos.length, 2);
    const led = r.json.repos.find((x) => x.repo === 'led/ger');
    assert.equal(led.lastVerdict, 'SHIP');
    assert.ok(led.receiptId);
  } finally { await c.close(); }
});

test('console: review diff-mode SHIP on a clean diff', async () => {
  const c = await boot();
  try {
    const clean = await c.call('POST', '/api/review', { diff: CLEAN_DIFF, repo: 'o/r', pr: 2 });
    assert.equal(clean.status, 200);
    assert.equal(clean.json.verdict, 'SHIP');
    assert.equal(clean.json.findings.blocking.length, 0);
  } finally { await c.close(); }
});

test('console: review dirty diff blocks with cited findings', async () => {
  const c = await boot();
  try {
    const { status, json } = await c.call('POST', '/api/review', { diff: EVAL_DIFF, repo: 'o/r', pr: 3 });
    assert.equal(status, 200);
    assert.equal(json.verdict, 'DO_NOT_SHIP');
    assert.equal(json.findings.blocking[0].ruleId, 'no-eval-with-dynamic-input');
    assert.ok(json.summary.files >= 1);
    assert.ok(json.receipt.receipt_id);
    const ledger = await c.call('GET', '/api/ledger?repo=o/r&pr=3');
    assert.equal(ledger.json.receipts.length, 1);
  } finally { await c.close(); }
});

test('console: review validates input', async () => {
  const c = await boot();
  try {
    assert.equal((await c.call('POST', '/api/review', {})).status, 400);
    assert.equal((await c.call('POST', '/api/review', { repo: 'o/r' })).status, 400);
  } finally { await c.close(); }
});

test('console: PR-mode STALE arrives in-band with receipt', async () => {
  const H1 = 'a'.repeat(40);
  const H2 = 'b'.repeat(40);
  let n = 0;
  const platform = {
    async getPR() { return { head: { sha: [H1, H2][Math.min(n++, 1)] }, base: { sha: 'c'.repeat(40) } }; },
    async getDiff() { return CLEAN_DIFF; },
  };
  const c = await boot({ platform });
  try {
    const { status, json } = await c.call('POST', '/api/review', { repo: 'o/r', pr: 4 });
    assert.equal(status, 200);
    assert.equal(json.verdict, 'STALE');
    assert.equal(json.staleReason !== undefined, true);
    assert.ok(json.receipt.receipt_id);
  } finally { await c.close(); }
});

test('console: PR-mode without platform fails closed', async () => {
  const c = await boot();
  try {
    const { status } = await c.call('POST', '/api/review', { repo: 'o/r', pr: 5 });
    assert.equal(status, 502);
  } finally { await c.close(); }
});

test('console: resolve requires a reason', async () => {
  const c = await boot();
  try {
    assert.equal((await c.call('POST', '/api/resolve', { ruleId: 'x', file: 'y' })).status, 400);
    const ok = await c.call('POST', '/api/resolve', { ruleId: 'x', file: 'y', evidence: 'e', reason: 'fp' });
    assert.equal(ok.status, 200);
    assert.ok(ok.json.fingerprint);
  } finally { await c.close(); }
});

test('console: verify endpoint round-trips', async () => {
  const c = await boot();
  try {
    const rec = makeReceipt({
      repo: 'o/r', prNumber: 1, headSha: 'h'.repeat(40), baseSha: 'b'.repeat(40),
      rulePackVersion: RULE_PACK_VERSION, verdict: 'SHIP',
      findings: { blocking: [], silenced: [], nonBlocking: [], excluded: [] },
      counts: { blocking: 0, silenced: 0, nonBlocking: 0, excluded: 0 },
      configHash: null, source: 'manual', environment: null, prevReceiptId: null,
    });
    assert.equal((await c.call('POST', '/api/verify', { receipt: rec })).json.valid, true);
    assert.equal((await c.call('POST', '/api/verify', { receipt: { ...rec, verdict: 'DO_NOT_SHIP' } })).json.valid, false);
    assert.equal((await c.call('POST', '/api/verify', {})).status, 400);
  } finally { await c.close(); }
});

test('console: rules and config surfaces', async () => {
  const c = await boot();
  try {
    const rules = await c.call('GET', '/api/rules');
    assert.equal(rules.json.rules.length, ruleIdsForPack(RULE_PACK_VERSION).length);
    const cfg = await c.call('GET', '/api/config');
    assert.deepEqual(cfg.json.config, { rulePack: null, exclude: [] });
    const put = await c.call('PUT', '/api/config', { rulePack: '1.0.0', exclude: ['docs/**'] });
    assert.equal(put.status, 200);
    assert.ok(put.json.configHash);
    assert.equal((await c.call('PUT', '/api/config', { severity: 'x' })).status, 400);
  } finally { await c.close(); }
});

test('console: token gate guards api but not healthz', async () => {
  const c = await boot({ token: 'tok' });
  try {
    assert.equal((await c.call('GET', '/api/healthz')).status, 200);
    assert.equal((await c.call('GET', '/api/rules')).status, 401);
    const authed = await c.call('GET', '/api/rules', undefined, { authorization: 'Bearer tok' });
    assert.equal(authed.status, 200);
    assert.equal(authed.json.rules.length, ruleIdsForPack(RULE_PACK_VERSION).length);
  } finally { await c.close(); }
});

test('console: static HEAD returns headers without body', async () => {
  const c = await boot();
  try {
    const head = await c.raw('HEAD', '/');
    assert.equal(head.status, 200);
    assert.ok(head.headers.get('content-type').includes('text/html'));
    assert.equal(await head.text(), '');
  } finally { await c.close(); }
});

test('console: unknown api routes 404, shell serves when public exists', async () => {
  const c = await boot();
  try {
    assert.equal((await c.call('GET', '/api/nope')).status, 404);
    const page = await c.raw('GET', '/');
    assert.equal(page.status, 200);
    assert.ok(page.headers.get('content-type').includes('text/html'));
    assert.ok((await page.text()).includes('Sentinel Console'));
    assert.equal((await c.raw('GET', '/does-not-exist-xyz')).status, 404);
  } finally { await c.close(); }
});


test('console: capability attestation query is authenticated, filtered and freshness-aware', async () => {
  const c = await boot({
    token: 'cap-token',
    capabilityAttestationStorePath: undefined,
  });
  await c.close();

  const dir = mkdtempSync(join(tmpdir(), 'sentinel-cap-query-'));
  const storePath = join(dir, 'capability-attestations.json');
  const store = createCapabilityAttestationStore(storePath);
  store.put({
    id: 'capatt_lenovo_computer',
    nodeId: 'wrkr_jonas_lenovo',
    capability: 'computer',
    state: 'AVAILABLE',
    observedAt: '2026-10-06T18:00:00.000Z',
    verifiedAt: '2026-10-06T18:00:05.000Z',
    freshnessTtlMs: 60_000,
    source: 'sentinel:computer-probe',
  });
  store.put({
    id: 'capatt_lenovo_local_device',
    nodeId: 'wrkr_jonas_lenovo',
    capability: 'local.device',
    state: 'REVOKED',
    observedAt: '2026-10-06T18:00:00.000Z',
    verifiedAt: '2026-10-06T18:00:05.000Z',
    freshnessTtlMs: 60_000,
    source: 'sentinel:computer-probe',
  });
  store.put({
    id: 'capatt_vds_browser',
    nodeId: 'wrkr_vds_1',
    capability: 'browser',
    state: 'AVAILABLE',
    observedAt: '2026-10-06T18:00:00.000Z',
    verifiedAt: '2026-10-06T18:00:05.000Z',
    freshnessTtlMs: 60_000,
    source: 'sentinel:browser-probe',
  });

  const handler = createConsoleServer({
    ledgerPath: join(dir, 'ledger.jsonl'),
    memoryPath: join(dir, 'mem.jsonl'),
    configPath: join(dir, 'sentinel.config.json'),
    token: 'cap-token',
    capabilityAttestationStorePath: storePath,
    capabilityAttestationNow: () => Date.parse('2026-10-06T18:01:06.000Z'),
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (headers = {}, body = {}) => {
    const res = await fetch(base + '/v1/capability-attestations/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  try {
    assert.equal((await call({}, {
      schema: 'aftergraph.capability-attestation-query/1.0',
      node_ids: ['wrkr_jonas_lenovo'],
      capabilities: ['computer'],
    })).status, 401);

    const out = await call(
      { authorization: 'Bearer cap-token' },
      {
        schema: 'aftergraph.capability-attestation-query/1.0',
        node_ids: ['wrkr_jonas_lenovo', 'wrkr_missing'],
        capabilities: ['local.device', 'computer'],
      },
    );
    assert.equal(out.status, 200);
    assert.equal(out.json.schema, 'aftergraph.capability-attestations/1.0');
    assert.deepEqual(
      out.json.attestations.map((item) => [item.id, item.state]),
      [
        ['capatt_lenovo_computer', 'STALE'],
        ['capatt_lenovo_local_device', 'REVOKED'],
      ],
    );
    assert.equal(JSON.stringify(out.json).includes('wrkr_vds_1'), false);

    const bad = await call(
      { authorization: 'Bearer cap-token' },
      {
        schema: 'aftergraph.capability-attestation-query/1.0',
        node_ids: [],
        capabilities: ['computer'],
      },
    );
    assert.equal(bad.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('console: capability attestation query fails closed when service is unconfigured', async () => {
  const c = await boot({ token: 'cap-token' });
  try {
    const out = await c.call(
      'POST',
      '/v1/capability-attestations/query',
      {
        schema: 'aftergraph.capability-attestation-query/1.0',
        node_ids: ['wrkr_jonas_lenovo'],
        capabilities: ['computer'],
      },
      { authorization: 'Bearer cap-token' },
    );
    assert.equal(out.status, 503);
    assert.equal(out.json.error, 'capability attestation store unavailable');
  } finally {
    await c.close();
  }
});

test('console: capability attestation query requires a configured service token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-cap-query-no-token-'));
  const storePath = join(dir, 'capability-attestations.json');
  createCapabilityAttestationStore(storePath);
  const handler = createConsoleServer({
    ledgerPath: join(dir, 'ledger.jsonl'),
    memoryPath: join(dir, 'mem.jsonl'),
    configPath: join(dir, 'sentinel.config.json'),
    capabilityAttestationStorePath: storePath,
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}/v1/capability-attestations/query`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          schema: 'aftergraph.capability-attestation-query/1.0',
          node_ids: ['wrkr_jonas_lenovo'],
          capabilities: ['computer'],
        }),
      },
    );
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'capability attestation service unavailable' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
