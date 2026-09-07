import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clear } from '../lib/audit.js';
import { handleInstallation, selectRepo } from '../apps/github/store.js';
import { postCheck } from '../apps/github/checks.js';
import { routeEvent } from '../apps/github/app.js';
import { createGhClient, resolveInstallationToken } from '../apps/github/gh-client.js';

const H1 = 'a'.repeat(40);
const B = 'c'.repeat(40);

// Fake exec recording argv (+opts). Never touches the network: stdout comes
// from the canned queue, or every call throws `error` when set.
function makeSpyExec({ outputs = [], error = null } = {}) {
  const calls = [];
  const queue = [...outputs];
  const exec = (argv, opts = {}) => {
    calls.push({ argv: [...argv], opts: { ...opts } });
    if (error) throw error;
    if (queue.length === 0) throw new Error('spy exec: no canned output left');
    return queue.shift();
  };
  return { calls, exec };
}

// Map the `-f key=value` pairs of an argv array for field assertions.
function fieldMap(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-f' && i + 1 < argv.length) {
      const eq = argv[i + 1].indexOf('=');
      out[argv[i + 1].slice(0, eq)] = argv[i + 1].slice(eq + 1);
      i++;
    }
  }
  return out;
}

function methodOf(argv) {
  return argv[argv.indexOf('--method') + 1];
}

function setupRepo(dir, repo = 'octo/hello') {
  const storePath = join(dir, 'installations.json');
  handleInstallation(
    { action: 'created', installation: { id: 123, account: { login: 'octo' } }, repositories: [] },
    { storePath },
  );
  selectRepo(123, repo, { storePath });
  return { storePath };
}

const CLEAN_DIFF = `diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
`;

function mockPlatform({ heads = [H1], comments = [] } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    async getPR() {
      calls.push('getPR');
      return { head: { sha: heads[Math.min(n++, heads.length - 1)] }, base: { sha: B } };
    },
    async getDiff() { calls.push('getDiff'); return CLEAN_DIFF; },
    async listComments() { calls.push('listComments'); return comments; },
    async postComment(repo, pr, body) { calls.push(['post', body]); return { id: 1 }; },
    async patchComment(repo, id, body) { calls.push(['patch', id, body]); return { id }; },
  };
}

test('gh-client: create maps to POST repos/{repo}/check-runs with full fields', async () => {
  const { calls, exec } = makeSpyExec({ outputs: [JSON.stringify({ id: 501 })] });
  const api = createGhClient({ exec, repo: 'octo/hello' });
  const res = await api.createCheckRun({
    name: 'sentinel/review',
    head_sha: H1,
    status: 'completed',
    conclusion: 'success',
    output: { title: 'T', summary: 'S', text: 'X' },
  });
  assert.equal(res.id, 501);
  assert.equal(calls.length, 1);
  const { argv } = calls[0];
  assert.equal(argv[0], 'api');
  assert.ok(argv.includes('repos/octo/hello/check-runs'));
  assert.ok(!argv.some((a) => a.includes('check-runs/')), 'create must not target a run id');
  assert.equal(methodOf(argv), 'POST');
  assert.deepEqual(fieldMap(argv), {
    name: 'sentinel/review',
    head_sha: H1,
    status: 'completed',
    conclusion: 'success',
    'output[title]': 'T',
    'output[summary]': 'S',
    'output[text]': 'X',
  });
});

test('gh-client: update maps to PATCH repos/{repo}/check-runs/{id}', async () => {
  const { calls, exec } = makeSpyExec({ outputs: [JSON.stringify({ id: 501 })] });
  const api = createGhClient({ exec, repo: 'octo/hello' });
  await api.updateCheckRun(501, {
    status: 'completed',
    conclusion: 'failure',
    output: { title: '[STALE] T', summary: 'Superseded', text: 'old' },
  });
  assert.equal(calls.length, 1);
  const { argv } = calls[0];
  assert.equal(argv[0], 'api');
  assert.ok(argv.includes('repos/octo/hello/check-runs/501'));
  assert.equal(methodOf(argv), 'PATCH');
  const fields = fieldMap(argv);
  assert.equal(fields.conclusion, 'failure');
  assert.equal(fields['output[title]'], '[STALE] T');
});

test('gh-client: conclusion passes through verbatim; name/status default; per-call repo', async () => {
  const outputs = ['success', 'failure', 'neutral'].map((c) => JSON.stringify({ id: 1, conclusion: c }));
  const { calls, exec } = makeSpyExec({ outputs });
  const api = createGhClient({ exec, repo: 'octo/hello' });
  for (const conclusion of ['success', 'failure', 'neutral']) {
    await api.createCheckRun({ head_sha: H1, conclusion, output: { title: 't', summary: 's', text: 'x' } });
  }
  assert.deepEqual(calls.map((c) => fieldMap(c.argv).conclusion), ['success', 'failure', 'neutral']);
  // Name/status default to sentinel/review + completed when omitted.
  assert.deepEqual(calls.map((c) => fieldMap(c.argv).name), ['sentinel/review', 'sentinel/review', 'sentinel/review']);
  assert.deepEqual(calls.map((c) => fieldMap(c.argv).status), ['completed', 'completed', 'completed']);

  // Per-call repo overrides the bound repo (constructor repo optional).
  const spy2 = makeSpyExec({ outputs: [JSON.stringify({ id: 2 })] });
  const api2 = createGhClient({ exec: spy2.exec });
  await api2.createCheckRun({ repo: 'other/repo', head_sha: H1, conclusion: 'success', output: { title: 't', summary: 's', text: 'x' } });
  assert.ok(spy2.calls[0].argv.includes('repos/other/repo/check-runs'));

  // Missing repo/head_sha/conclusion fail closed before any exec call.
  const spy3 = makeSpyExec({ outputs: [JSON.stringify({ id: 3 })] });
  const api3 = createGhClient({ exec: spy3.exec });
  await assert.rejects(api3.createCheckRun({ head_sha: H1, conclusion: 'success', output: {} }), /repo.*fail closed/i);
  await assert.rejects(api3.updateCheckRun(undefined, { conclusion: 'success' }), /check-run id/);
  assert.equal(spy3.calls.length, 0);
});

test('gh-client: exec failure throws fail-closed with truncated stderr', async () => {
  const err = new Error('Command failed: gh api repos/octo/hello/check-runs');
  err.status = 1;
  err.stderr = `E${'r'.repeat(9999)}`;
  const { exec } = makeSpyExec({ error: err });
  const api = createGhClient({ exec, repo: 'octo/hello' });
  await assert.rejects(
    api.createCheckRun({ head_sha: H1, conclusion: 'success', output: { title: 't', summary: 's', text: 'x' } }),
    (e) => {
      assert.match(e.message, /fail closed/i);
      assert.ok(e.message.includes('E' + 'r'.repeat(100)), 'stderr must be attached');
      assert.ok(e.message.length < 3000, `stderr must be truncated (got ${e.message.length} chars)`);
      assert.match(e.message, /truncated/);
      return true;
    },
  );
  await assert.rejects(api.updateCheckRun(9, { conclusion: 'success' }), /fail closed/i);
});

test('gh-client: missing gh binary gives an actionable error', async () => {
  const enoent = Object.assign(new Error('spawnSync gh ENOENT'), { code: 'ENOENT' });
  const { exec } = makeSpyExec({ error: enoent });
  const api = createGhClient({ exec, repo: 'octo/hello' });
  await assert.rejects(
    api.createCheckRun({ head_sha: H1, conclusion: 'success', output: { title: 't', summary: 's', text: 'x' } }),
    (e) => {
      assert.match(e.message, /fail closed/i);
      assert.match(e.message, /gh CLI binary not found/);
      assert.match(e.message, /cli\.github\.com/);
      assert.match(e.message, /gh auth login/);
      return true;
    },
  );
});

test('gh-client: installation token resolves without leaking into any other call', async () => {
  const TOKEN = 'ghs_test_token_9f8e7d6c5b4a39482716';
  const APP_JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MifQ.c2ln';
  const spy = makeSpyExec({
    outputs: [
      JSON.stringify({ token: TOKEN, expires_at: '2030-01-01T00:00:00Z' }),
      JSON.stringify({ id: 700 }),
      JSON.stringify({ id: 700 }),
    ],
  });
  const { token, expiresAt } = await resolveInstallationToken({ appJwt: APP_JWT, installationId: 42, exec: spy.exec });
  assert.equal(token, TOKEN);
  assert.equal(expiresAt, '2030-01-01T00:00:00Z');

  // Token call shape: POST app/installations/{id}/access_tokens.
  assert.ok(spy.calls[0].argv.includes('app/installations/42/access_tokens'));
  assert.equal(methodOf(spy.calls[0].argv), 'POST');

  // Use the token for check runs: auth must travel via env, never argv.
  const api = createGhClient({ exec: spy.exec, repo: 'o/r', token });
  await api.createCheckRun({ head_sha: H1, conclusion: 'success', output: { title: 't', summary: 's', text: 'x' } });
  await api.updateCheckRun(700, { conclusion: 'success' });
  assert.equal(spy.calls[1].opts.env.GH_TOKEN, TOKEN);
  assert.equal(spy.calls[2].opts.env.GH_TOKEN, TOKEN);
  for (const c of spy.calls) {
    const argvText = c.argv.join('\n');
    assert.ok(!argvText.includes(TOKEN), 'installation token leaked into gh argv');
    assert.ok(!argvText.includes(APP_JWT), 'app JWT leaked into gh argv');
    if (c.opts.input) assert.ok(!String(c.opts.input).includes(TOKEN));
  }

  // access_tokens with no token fails closed.
  const empty = makeSpyExec({ outputs: [JSON.stringify({})] });
  await assert.rejects(
    resolveInstallationToken({ appJwt: APP_JWT, installationId: 42, exec: empty.exec }),
    /fail closed.*no token/i,
  );
});

test('gh-client: postCheck end-to-end over injected gh exec', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghclient-'));
  clear();
  try {
    const { storePath } = setupRepo(dir);
    const spy = makeSpyExec({ outputs: [JSON.stringify({ id: 900 })] });
    const api = createGhClient({ exec: spy.exec, repo: 'octo/hello' });
    const out = await postCheck(
      { api, repo: 'octo/hello', prNumber: 7, headSha: H1, verdict: 'SHIP', findings: [] },
      { storePath },
    );
    assert.equal(out.action, 'created');
    assert.equal(out.checkRunId, 900);
    assert.equal(out.conclusion, 'success');
    // Verdict mapping survived transport; the exact HEAD is on the wire.
    const fields = fieldMap(spy.calls[0].argv);
    assert.equal(fields.conclusion, 'success');
    assert.equal(fields.head_sha, H1);
    assert.ok(fields['output[summary]'].includes(H1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github app: ghChecks wiring posts checks; absence preserves prior shape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghwire-'));
  clear();
  try {
    const { storePath } = setupRepo(dir, 'o/r');
    const base = {
      event: 'pull_request',
      payload: { action: 'opened', repository: { full_name: 'o/r' }, pull_request: { number: 7 } },
    };
    const ledgerPath = join(dir, 'ledger.jsonl');
    const memoryPath = join(dir, 'mem.jsonl');

    // Opted in: per-event gh client posts the check run for the event repo.
    const spy = makeSpyExec({ outputs: [JSON.stringify({ id: 910 })] });
    const platform = mockPlatform();
    const wired = await routeEvent({
      ...base,
      platform,
      opts: { ledgerPath, memoryPath, storePath, ghChecks: true, ghExec: spy.exec },
    });
    assert.equal(wired.verdict, 'SHIP');
    assert.equal(wired.check.action, 'created');
    assert.equal(wired.check.checkRunId, 910);
    assert.ok(spy.calls[0].argv.includes('repos/o/r/check-runs'));

    // Not opted in: exact prior return shape, no check key, no gh call.
    const spy2 = makeSpyExec({ outputs: [JSON.stringify({ id: 911 })] });
    const plain = await routeEvent({
      ...base,
      platform: mockPlatform(),
      opts: { ledgerPath, memoryPath, storePath, ghExec: spy2.exec },
    });
    assert.deepEqual(Object.keys(plain).sort(), ['action', 'handled', 'receipt', 'verdict']);
    assert.equal(spy2.calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
