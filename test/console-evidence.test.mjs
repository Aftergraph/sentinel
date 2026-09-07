import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createConsoleServer } from '../console/server.js';
import { createEvidenceStore } from '../lib/evidence-store.js';

const EVAL_DIFF = `diff --git a/srv/app.js b/srv/app.js
index 1111111..2222222 100644
--- a/srv/app.js
+++ b/srv/app.js
@@ -1,3 +1,4 @@
 export function run(input) {
+  return eval(input);
 }
`;

const H1 = 'a'.repeat(40);

const LEGACY_RUN_KEYS = [
  'id', 'findingRef', 'targetSha', 'status', 'progress', 'checks',
  'evidenceIds', 'stale', 'staleReason', 'ledgerHead',
];

function paths(dir) {
  return {
    ledgerPath: join(dir, 'ledger.jsonl'),
    memoryPath: join(dir, 'mem.jsonl'),
    // Hermetic: never discover cwd config (a stray file would poison results).
    configPath: join(dir, 'sentinel.config.json'),
    evidenceStorePath: join(dir, 'evidence.json'),
  };
}

// Boot a console on an existing dir. close() stops HTTP only; the caller
// owns the dir (so a second instance can reuse the same paths).
async function bootOnDir(dir, { withStore = false, ...opts } = {}) {
  const p = paths(dir);
  const handler = createConsoleServer({
    ledgerPath: p.ledgerPath,
    memoryPath: p.memoryPath,
    configPath: p.configPath,
    ...(withStore ? { evidenceStorePath: p.evidenceStorePath } : {}),
    ...opts,
  });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    dir,
    storePath: p.evidenceStorePath,
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
    },
  };
}

async function boot(opts = {}) {
  return bootOnDir(mkdtempSync(join(tmpdir(), 'sentinel-console-evidence-')), opts);
}

// Reviews H1, then starts a run for the first blocking finding of repo+pr.
async function setupRun(c, repo = 'o/v', pr = 7, head = H1) {
  const posted = await c.call('POST', '/api/review', { diff: EVAL_DIFF, repo, pr, headSha: head });
  assert.equal(posted.status, 200);
  const prec = await c.call('GET', `/api/pr/${encodeURIComponent(repo)}/${pr}`);
  assert.equal(prec.status, 200);
  assert.ok(prec.json.blocking.length >= 1);
  const f = prec.json.blocking[0];
  const started = await c.call('POST', '/api/verify/start', {
    repo, prNumber: pr, ruleId: f.ruleId, line: f.line,
  });
  return { posted, finding: f, started };
}

test('console-evidence: unconfigured path unchanged (legacy shape, no store)', async () => {
  const c = await boot();
  try {
    const { started } = await setupRun(c);
    assert.equal(started.status, 200);
    assert.deepEqual(Object.keys(started.json).sort(), [...LEGACY_RUN_KEYS].sort());
    assert.ok(!('evidence' in started.json));
    assert.deepEqual(started.json.evidenceIds, []);
    const got = await c.call('GET', `/api/verify/${started.json.id}`);
    assert.equal(got.status, 200);
    assert.deepEqual(Object.keys(got.json).sort(), [...LEGACY_RUN_KEYS].sort());
    assert.ok(!('evidence' in got.json));
    // No store file is created when unconfigured.
    assert.deepEqual(readdirSync(c.dir).filter((f) => f.includes('evidence')), []);
  } finally {
    await c.close();
    rmSync(c.dir, { recursive: true, force: true });
  }
});

test('console-evidence: sealed evidence persists, hashes match memory-vs-store', async () => {
  const c = await boot({ withStore: true });
  try {
    const { started } = await setupRun(c);
    assert.equal(started.status, 200);
    const runId = started.json.id;
    assert.ok(Array.isArray(started.json.evidence));
    assert.equal(started.json.evidence.length, started.json.checks.length);
    assert.ok(started.json.evidence.length > 0);

    const got = await c.call('GET', `/api/verify/${runId}`);
    assert.equal(got.status, 200);
    assert.deepEqual(got.json.evidence, started.json.evidence);

    // Served entries carry stored hashes: id IS the content hash, and the
    // run id list covers every sealed id.
    for (const e of got.json.evidence) {
      assert.deepEqual(Object.keys(e).sort(), ['hash', 'id', 'runId', 'targetSha', 'type']);
      assert.equal(e.hash, e.id);
      assert.match(e.id, /^[0-9a-f]{64}$/);
      assert.equal(e.runId, runId);
      assert.equal(e.targetSha, H1);
      assert.ok(got.json.evidenceIds.includes(e.id));
    }

    // Memory-vs-store: the store file holds the same ids + hashes
    // (atomic write: valid JSON, no tmp leftovers, clean inventory).
    const raw = JSON.parse(readFileSync(c.storePath, 'utf8'));
    assert.ok(Array.isArray(raw.items));
    assert.equal(raw.items.length, got.json.checks.length);
    assert.deepEqual(readdirSync(c.dir).filter((f) => f.endsWith('.tmp')), []);
    const store = createEvidenceStore(c.storePath);
    assert.deepEqual(store.verifyAll(), { ok: true, checked: raw.items.length, bad: [] });
    const byRun = store.listByRun(runId);
    assert.deepEqual(
      byRun.map((e) => e.id).sort(),
      got.json.evidence.map((e) => e.id).sort(),
    );
    for (const e of got.json.evidence) {
      assert.equal(store.get(e.id).outputHash, e.hash);
    }

    // In-memory fallback: removing the store file still serves the same
    // evidence from the start-time sealed items.
    rmSync(c.storePath);
    const fallback = await c.call('GET', `/api/verify/${runId}`);
    assert.equal(fallback.status, 200);
    assert.deepEqual(fallback.json.evidence, got.json.evidence);
  } finally {
    await c.close();
    rmSync(c.dir, { recursive: true, force: true });
  }
});

test('console-evidence: evidence survives across server instances on the same store file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-console-evidence-restart-'));
  const s1 = await bootOnDir(dir, { withStore: true });
  let first;
  try {
    const { started } = await setupRun(s1);
    assert.equal(started.status, 200);
    first = await s1.call('GET', `/api/verify/${started.json.id}`);
    assert.equal(first.status, 200);
    assert.ok(first.json.evidence.length > 0);
  } finally {
    await s1.close();
  }
  // Restart simulation: a fresh instance on the same ledger + store paths.
  const s2 = await bootOnDir(dir, { withStore: true });
  try {
    const prec = await s2.call('GET', '/api/pr/o%2Fv/7');
    assert.equal(prec.status, 200);
    const f = prec.json.blocking[0];
    const restarted = await s2.call('POST', '/api/verify/start', {
      repo: 'o/v', prNumber: 7, ruleId: f.ruleId, line: f.line,
    });
    assert.equal(restarted.status, 200);
    // Deterministic run id: the replayed start reclaims VR-0001.
    assert.equal(restarted.json.id, first.json.id);
    const second = await s2.call('GET', `/api/verify/${restarted.json.id}`);
    assert.equal(second.status, 200);
    // Same sealed evidence, served from the shared store file.
    assert.deepEqual(second.json.evidence, first.json.evidence);
    assert.deepEqual(second.json.evidenceIds, first.json.evidenceIds);
    // Content-addressed dedupe: replaying the start adds no duplicates.
    const store = createEvidenceStore(join(dir, 'evidence.json'));
    assert.equal(store.listByRun(first.json.id).length, first.json.checks.length);
  } finally {
    await s2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('console-evidence: corrupt store fails closed on evidence routes only', async () => {
  const c = await boot({ withStore: true });
  try {
    const { started } = await setupRun(c);
    assert.equal(started.status, 200);
    const runId = started.json.id;

    writeFileSync(c.storePath, '{not json');
    const getBad = await c.call('GET', `/api/verify/${runId}`);
    assert.equal(getBad.status, 500);
    assert.equal(getBad.json.error, 'evidence store unavailable');
    assert.ok(!JSON.stringify(getBad.json).includes('not json'));

    const postBad = await c.call('POST', '/api/verify/start', {
      repo: 'o/v', prNumber: 7, ruleId: 'no-eval-with-dynamic-input', line: started.json.findingRef.line,
    });
    assert.equal(postBad.status, 500);
    assert.equal(postBad.json.error, 'evidence store unavailable');
    assert.ok(!JSON.stringify(postBad.json).includes('not json'));

    // Isolation: unrelated routes are unaffected.
    assert.equal((await c.call('GET', '/api/healthz')).status, 200);
    assert.equal((await c.call('GET', '/api/healthz')).json.ok, true);
    assert.equal((await c.call('GET', '/api/rules')).status, 200);
    // The corrupt file is never rewritten or reset.
    assert.equal(readFileSync(c.storePath, 'utf8'), '{not json');
  } finally {
    await c.close();
    rmSync(c.dir, { recursive: true, force: true });
  }
});

test('console-evidence: token gate enforced with a store configured', async () => {
  const c = await boot({ withStore: true, token: 'tok' });
  const auth = { authorization: `Bearer ${'tok'}` };
  try {
    await c.call('POST', '/api/review', { diff: EVAL_DIFF, repo: 'o/v', pr: 7, headSha: H1 }, auth);
    const prec = await c.call('GET', '/api/pr/o%2Fv/7', undefined, auth);
    const f = prec.json.blocking[0];
    const body = { repo: 'o/v', prNumber: 7, ruleId: f.ruleId, line: f.line };
    assert.equal((await c.call('POST', '/api/verify/start', body)).status, 401);
    const started = await c.call('POST', '/api/verify/start', body, auth);
    assert.equal(started.status, 200);
    assert.ok(started.json.evidence.length > 0);
    assert.equal((await c.call('GET', `/api/verify/${started.json.id}`)).status, 401);
    const authed = await c.call('GET', `/api/verify/${started.json.id}`, undefined, auth);
    assert.equal(authed.status, 200);
    assert.deepEqual(authed.json.evidence, started.json.evidence);
    // Gate precedes the store: unauthenticated stays 401 even when corrupt.
    writeFileSync(c.storePath, '{not json');
    assert.equal((await c.call('GET', `/api/verify/${started.json.id}`)).status, 401);
    const corruptAuthed = await c.call('GET', `/api/verify/${started.json.id}`, undefined, auth);
    assert.equal(corruptAuthed.status, 500);
    assert.equal(corruptAuthed.json.error, 'evidence store unavailable');
  } finally {
    await c.close();
    rmSync(c.dir, { recursive: true, force: true });
  }
});
