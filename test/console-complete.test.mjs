import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createConsoleServer } from '../console/server.js';
import { sealEvidence } from '../lib/evidence.js';

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
const H2 = 'b'.repeat(40);

async function boot(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-complete-'));
  const handler = createConsoleServer({
    ledgerPath: join(dir, 'ledger.jsonl'),
    memoryPath: join(dir, 'mem.jsonl'),
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
    async close() {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

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
  assert.equal(started.status, 200);
  return { posted, finding: f, started: started.json };
}

function passResults(run) {
  return run.checks.map((c) => ({ type: c.type, status: 'pass', exitCode: 0 }));
}

function sealFor(runId, targetSha, type = 'TEST') {
  return sealEvidence({
    runId,
    targetSha,
    type,
    command: `verify:${type}`,
    exitCode: 0,
    result: 'pass',
    artifacts: [],
  });
}

test('complete: happy path PENDING->PASS with finding CONFIRMED (operator-asserted)', async () => {
  const c = await boot();
  try {
    const { started } = await setupRun(c);
    assert.equal(started.status, 'PENDING');
    const ev = sealFor(started.id, H1, started.checks[0].type);
    const done = await c.call('POST', `/api/verify/${started.id}/complete`, {
      results: passResults(started),
      evidence: [ev],
    });
    assert.equal(done.status, 200);
    assert.equal(done.json.id, started.id);
    assert.equal(done.json.status, 'PASS');
    assert.equal(done.json.targetSha, H1);
    for (const ch of done.json.checks) assert.equal(ch.status, 'PASS');
    assert.equal(done.json.progress.done, done.json.progress.total);
    assert.ok(done.json.evidenceIds.includes(ev.id));
    // Finding transition via seeded ledger finding.
    assert.equal(done.json.finding.to, 'CONFIRMED');
    assert.equal(done.json.finding.verification_state, 'CONFIRMED');
    assert.equal(done.json.findingTransition.to, 'CONFIRMED');
    // VibeSec: operator-asserted, no server-side exec.
    assert.equal(done.json.assertedBy, 'operator');
    // Persisted: poll shows the completed run.
    const got = await c.call('GET', `/api/verify/${started.id}`);
    assert.equal(got.status, 200);
    assert.equal(got.json.status, 'PASS');
    assert.ok(got.json.evidenceIds.includes(ev.id));
  } finally { await c.close(); }
});

test('complete: missing required check 400s fail-closed, run untouched', async () => {
  const c = await boot();
  try {
    const { started } = await setupRun(c);
    const before = await c.call('GET', `/api/verify/${started.id}`);
    assert.equal(before.status, 200);
    const partial = passResults(started).slice(1);
    assert.ok(partial.length < started.checks.length);
    const res = await c.call('POST', `/api/verify/${started.id}/complete`, {
      results: partial,
      evidence: [],
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /BLOCKED|missing/i);
    const after = await c.call('GET', `/api/verify/${started.id}`);
    assert.equal(after.status, 200);
    assert.deepEqual(after.json, before.json);
    assert.equal(after.json.status, 'PENDING');
  } finally { await c.close(); }
});

test('complete: evidence targetSha mismatch 400s fail-closed, run untouched', async () => {
  const c = await boot();
  try {
    const { started } = await setupRun(c);
    const before = await c.call('GET', `/api/verify/${started.id}`);
    const bad = sealFor(started.id, H2, started.checks[0].type);
    const res = await c.call('POST', `/api/verify/${started.id}/complete`, {
      results: passResults(started),
      evidence: [bad],
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /INVALID_VERIFICATION|targetSha|mismatch/i);
    const after = await c.call('GET', `/api/verify/${started.id}`);
    assert.equal(after.status, 200);
    assert.deepEqual(after.json, before.json);
    assert.equal(after.json.status, 'PENDING');
  } finally { await c.close(); }
});

test('complete: tampered evidence seal 400s, run untouched', async () => {
  const c = await boot();
  try {
    const { started } = await setupRun(c);
    const ev = sealFor(started.id, H1, started.checks[0].type);
    const tampered = { ...ev, result: 'tampered' };
    const res = await c.call('POST', `/api/verify/${started.id}/complete`, {
      results: passResults(started),
      evidence: [tampered],
    });
    assert.equal(res.status, 400);
    assert.match(res.json.error, /seal/i);
    const after = await c.call('GET', `/api/verify/${started.id}`);
    assert.equal(after.json.status, 'PENDING');
  } finally { await c.close(); }
});

test('complete: double-complete 409, no second mutation', async () => {
  const c = await boot();
  try {
    const { started } = await setupRun(c);
    const ev = sealFor(started.id, H1, started.checks[0].type);
    const first = await c.call('POST', `/api/verify/${started.id}/complete`, {
      results: passResults(started),
      evidence: [ev],
    });
    assert.equal(first.status, 200);
    assert.equal(first.json.status, 'PASS');
    const second = await c.call('POST', `/api/verify/${started.id}/complete`, {
      results: passResults(started),
      evidence: [ev],
    });
    assert.equal(second.status, 409);
    const got = await c.call('GET', `/api/verify/${started.id}`);
    assert.equal(got.json.status, 'PASS');
    assert.deepEqual(got.json.evidenceIds, first.json.evidenceIds);
  } finally { await c.close(); }
});

test('complete: unknown run 404', async () => {
  const c = await boot();
  try {
    const res = await c.call('POST', '/api/verify/VR-9999/complete', {
      results: [],
      evidence: [],
    });
    assert.equal(res.status, 404);
  } finally { await c.close(); }
});

test('complete: mass-assignment guard rejects unknown fields with 400', async () => {
  const c = await boot();
  try {
    const { started } = await setupRun(c);
    const extraTop = await c.call('POST', `/api/verify/${started.id}/complete`, {
      results: passResults(started),
      evidence: [],
      status: 'PASS',
    });
    assert.equal(extraTop.status, 400);
    const extraInner = await c.call('POST', `/api/verify/${started.id}/complete`, {
      results: passResults(started).map((r) => ({ ...r, command: 'rm -rf /' })),
      evidence: [],
    });
    assert.equal(extraInner.status, 400);
    const after = await c.call('GET', `/api/verify/${started.id}`);
    assert.equal(after.json.status, 'PENDING');
  } finally { await c.close(); }
});

test('complete: token gate enforced (401 without token, 200 with)', async () => {
  const c = await boot({ token: 'tok' });
  const auth = { authorization: 'Bearer tok' };
  try {
    await c.call('POST', '/api/review', { diff: EVAL_DIFF, repo: 'o/v', pr: 7, headSha: H1 }, auth);
    const prec = await c.call('GET', '/api/pr/o%2Fv/7', undefined, auth);
    const f = prec.json.blocking[0];
    const started = await c.call('POST', '/api/verify/start', {
      repo: 'o/v', prNumber: 7, ruleId: f.ruleId, line: f.line,
    }, auth);
    assert.equal(started.status, 200);
    const run = started.json;
    const body = { results: run.checks.map((x) => ({ type: x.type, status: 'pass' })), evidence: [] };
    assert.equal((await c.call('POST', `/api/verify/${run.id}/complete`, body)).status, 401);
    const ok = await c.call('POST', `/api/verify/${run.id}/complete`, body, auth);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.assertedBy, 'operator');
    assert.equal(ok.json.status, 'PASS');
  } finally { await c.close(); }
});
