import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createConsoleServer } from '../console/server.js';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const H3 = 'c'.repeat(40);

const CLEAN_DIFF = `diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
`;

function topoOpts(dir, extra = {}) {
  return {
    ledgerPath: join(dir, 'ledger.jsonl'),
    memoryPath: join(dir, 'mem.jsonl'),
    configPath: join(dir, 'sentinel.config.json'),
    ...extra,
  };
}

async function boot(opts = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'sentinel-topo-scratch-'));
  const handler = createConsoleServer({
    ledgerPath: join(scratch, 'ledger.jsonl'),
    memoryPath: join(scratch, 'mem.jsonl'),
    configPath: join(scratch, 'sentinel.config.json'),
    ...opts,
  });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    async get(path) {
      const res = await fetch(`${base}${path}`);
      return { status: res.status, json: await res.json() };
    },
    async post(path, body) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    },
    async close() {
      server.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

function writeTopoOrg(dir) {
  const topologyPath = join(dir, 'platform-topology.json');
  const orgStatePath = join(dir, 'latest-org-state.json');
  writeFileSync(topologyPath, JSON.stringify({
    version: 'platform-topology/1.0',
    repos: ['both/repo', 'topo/only', 'topo/bare', { repo: 'topo/withsha', headSha: H3 }],
  }));
  writeFileSync(orgStatePath, JSON.stringify({
    repos: [
      { repo: 'both/repo', headSha: H1 },
      { repo: 'topo/only', headSha: H2 },
    ],
  }));
  return { topologyPath, orgStatePath };
}

test('console v1b: repos union flags + topology + ledger with headSource labels', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-topo-'));
  try {
    const { topologyPath, orgStatePath } = writeTopoOrg(dir);
    const c = await boot(topoOpts(dir, {
      repos: ['flag/only', 'both/repo'],
      topologyPath,
      orgStatePath,
    }));
    try {
      await c.post('/api/review', { diff: CLEAN_DIFF, repo: 'both/repo', pr: 1 });
      await c.post('/api/review', { diff: CLEAN_DIFF, repo: 'ledger/only', pr: 1 });
      const { status, json } = await c.get('/api/repos');
      assert.equal(status, 200);
      const byRepo = new Map(json.repos.map((r) => [r.repo, r]));

      assert.deepEqual([...byRepo.keys()].sort(), [
        'both/repo', 'flag/only', 'ledger/only', 'topo/bare', 'topo/only', 'topo/withsha',
      ]);
      // org-state HEAD wins over the ledger HEAD for a matched repo,
      // while the ledger verdict pill is still attached.
      assert.equal(byRepo.get('both/repo').headSha, H1);
      assert.equal(byRepo.get('both/repo').headSource, 'org-state');
      assert.equal(byRepo.get('both/repo').lastVerdict, 'SHIP');
      assert.ok(byRepo.get('both/repo').receiptId);

      assert.equal(byRepo.get('topo/only').headSha, H2);
      assert.equal(byRepo.get('topo/only').headSource, 'org-state');

      assert.equal(byRepo.get('ledger/only').headSource, 'ledger');
      assert.ok(byRepo.get('ledger/only').headSha);
      assert.equal(byRepo.get('ledger/only').lastVerdict, 'SHIP');

      assert.equal(byRepo.get('topo/withsha').headSha, H3);
      assert.equal(byRepo.get('topo/withsha').headSource, 'topology');

      assert.equal(byRepo.get('topo/bare').headSource, 'topology');
      assert.equal(byRepo.get('topo/bare').headSha, undefined);

      assert.equal(byRepo.get('flag/only').headSource, 'flag');
      assert.equal(byRepo.get('flag/only').headSha, undefined);
    } finally { await c.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('console v1b: missing files warn to stderr but never crash', async () => {
  const c = await boot({
    repos: ['flag/only'],
    topologyPath: join('no-such-dir', 'platform-topology.json'),
    orgStatePath: join('no-such-dir', 'latest-org-state.json'),
  });
  const orig = console.error;
  const warned = [];
  console.error = (...a) => { warned.push(a.join(' ')); };
  try {
    const { status, json } = await c.get('/api/repos');
    assert.equal(status, 200);
    assert.deepEqual(json.repos, [{ repo: 'flag/only', headSource: 'flag' }]);
    assert.ok(warned.some((w) => w.includes('topology')));
    assert.ok(warned.some((w) => w.includes('org-state')));
  } finally {
    console.error = orig;
    await c.close();
  }
});

test('console v1b: malformed files warn and yield an empty union', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-topo-'));
  try {
    const badTopo = join(dir, 'bad-topology.json');
    const badOrg = join(dir, 'bad-org.json');
    writeFileSync(badTopo, '{ not json');
    writeFileSync(badOrg, '[1,2');
    const c = await boot(topoOpts(dir, { topologyPath: badTopo, orgStatePath: badOrg }));
    try {
      const { status, json } = await c.get('/api/repos');
      assert.equal(status, 200);
      assert.deepEqual(json.repos, []);
    } finally { await c.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('console v1a shape is unchanged when no topology flags are given', async () => {
  const c = await boot({ repos: ['flagged/repo'] });
  try {
    const { status, json } = await c.get('/api/repos');
    assert.equal(status, 200);
    assert.deepEqual(json.repos, [{ repo: 'flagged/repo' }]);
  } finally { await c.close(); }
});
