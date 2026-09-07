import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clear, list } from '../lib/audit.js';
import { handleInstallation, selectRepo } from '../apps/github/store.js';
import { postCheck, loadChecks } from '../apps/github/checks.js';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const H3 = 'c'.repeat(40);
const H4 = 'd'.repeat(40);
const H5 = 'e'.repeat(40);

// Recording fake for the injected async client { createCheckRun,
// updateCheckRun }. No network: every call is captured, ids are minted.
function makeFakeApi() {
  const calls = { creates: [], updates: [] };
  let nextId = 100;
  return {
    calls,
    async createCheckRun(params) {
      calls.creates.push(params);
      const id = nextId++;
      return { id };
    },
    async updateCheckRun(id, params) {
      calls.updates.push({ id, params });
      return { id };
    },
  };
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

function finding(overrides = {}) {
  return { ruleId: 'no-eval-with-dynamic-input', file: 'srv/app.js', line: 41, evidence: 'return eval(input)', ...overrides };
}

test('github checks: create-on-first-verdict shape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghchk-'));
  clear();
  try {
    const { storePath } = setupRepo(dir);
    const api = makeFakeApi();
    const out = await postCheck(
      { api, repo: 'octo/hello', prNumber: 7, headSha: H1, verdict: 'SHIP', summary: { files: 1, added: 2, removed: 0 }, findings: [finding(), finding({ line: 42 })] },
      { storePath },
    );
    assert.equal(out.action, 'created');
    assert.equal(out.conclusion, 'success');
    assert.equal(typeof out.checkRunId, 'number');

    // Exactly one create, no update.
    assert.equal(api.calls.creates.length, 1);
    assert.equal(api.calls.updates.length, 0);
    const created = api.calls.creates[0];
    assert.equal(created.name, 'sentinel/review');
    assert.equal(created.head_sha, H1);
    assert.equal(created.status, 'completed');
    assert.equal(created.conclusion, 'success');
    // Output carries the verdict, the EXACT head, and the top findings.
    assert.ok(created.output.title.includes('SHIP'));
    assert.ok(created.output.summary.includes('SHIP'));
    assert.ok(created.output.summary.includes(H1));
    assert.ok(created.output.text.includes('no-eval-with-dynamic-input'));
    assert.ok(created.output.text.includes('srv/app.js:41'));
    assert.ok(created.output.text.includes('srv/app.js:42'));

    // Persisted under repo+pr+headSha; one audit event by github-app.
    const stored = loadChecks(join(dir, 'github-checks.json'));
    assert.equal(Object.keys(stored).length, 1);
    assert.equal(stored[`octo/hello#7#${H1}`].checkRunId, out.checkRunId);
    const events = list().filter((e) => e.type === 'check.created');
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, 'github-app');

    // Findings without ruleId+file+line reject fail-closed (nothing posted).
    await assert.rejects(
      postCheck({ api, repo: 'octo/hello', prNumber: 8, headSha: H2, verdict: 'SHIP', findings: [{ file: 'a.js', line: 1 }] }, { storePath }),
      /ruleId/,
    );
    assert.equal(api.calls.creates.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github checks: verdict→conclusion mapping incl STALE→neutral', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghchk-'));
  clear();
  try {
    const { storePath } = setupRepo(dir);
    const api = makeFakeApi();
    const cases = [
      ['SHIP', H1, 11, 'success'],
      ['DO_NOT_SHIP', H2, 12, 'failure'],
      ['STALE', H3, 13, 'neutral'],
      ['BLOCKED', H4, 14, 'failure'],
    ];
    for (const [verdict, headSha, pr, conclusion] of cases) {
      const out = await postCheck({ api, repo: 'octo/hello', prNumber: pr, headSha, verdict, findings: [] }, { storePath });
      assert.equal(out.conclusion, conclusion, verdict);
    }
    assert.deepEqual(api.calls.creates.map((c) => c.conclusion), ['success', 'failure', 'neutral', 'failure']);
    // Unknown verdicts reject fail-closed.
    await assert.rejects(
      postCheck({ api, repo: 'octo/hello', prNumber: 15, headSha: H5, verdict: 'MAYBE', findings: [] }, { storePath }),
      /verdict/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github checks: same-headSha redelivery updates in place (no duplicates)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghchk-'));
  clear();
  try {
    const { storePath } = setupRepo(dir);
    const api = makeFakeApi();
    const first = await postCheck(
      { api, repo: 'octo/hello', prNumber: 7, headSha: H1, verdict: 'DO_NOT_SHIP', findings: [finding()] },
      { storePath },
    );
    const second = await postCheck(
      { api, repo: 'octo/hello', prNumber: 7, headSha: H1, verdict: 'DO_NOT_SHIP', findings: [finding()] },
      { storePath },
    );
    assert.equal(second.action, 'updated');
    assert.equal(second.checkRunId, first.checkRunId);
    assert.equal(second.conclusion, 'failure');
    // One create + one update, never a second create.
    assert.equal(api.calls.creates.length, 1);
    assert.equal(api.calls.updates.length, 1);
    assert.equal(api.calls.updates[0].id, first.checkRunId);
    assert.equal(api.calls.updates[0].params.conclusion, 'failure');
    assert.ok(api.calls.updates[0].params.output.summary.includes(H1));
    assert.equal(Object.keys(loadChecks(join(dir, 'github-checks.json'))).length, 1);
    assert.equal(list().filter((e) => e.type === 'check.updated').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github checks: HEAD move creates a new run + supersedes the old (never silently green)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghchk-'));
  clear();
  try {
    const { storePath } = setupRepo(dir);
    const api = makeFakeApi();
    const oldRun = await postCheck(
      { api, repo: 'octo/hello', prNumber: 7, headSha: H1, verdict: 'DO_NOT_SHIP', findings: [finding()] },
      { storePath },
    );
    const newRun = await postCheck(
      { api, repo: 'octo/hello', prNumber: 7, headSha: H2, verdict: 'SHIP', findings: [] },
      { storePath },
    );
    assert.equal(newRun.action, 'created');
    assert.notEqual(newRun.checkRunId, oldRun.checkRunId);
    assert.equal(newRun.conclusion, 'success');
    assert.deepEqual(newRun.superseded, [oldRun.checkRunId]);

    // Two creates (one per HEAD) + one supersede update of the OLD run.
    assert.equal(api.calls.creates.length, 2);
    assert.equal(api.calls.creates[1].head_sha, H2);
    assert.equal(api.calls.updates.length, 1);
    const stale = api.calls.updates[0];
    assert.equal(stale.id, oldRun.checkRunId);
    // Old conclusion unchanged (still failure — never silently green),
    // title prefixed [STALE].
    assert.equal(stale.params.conclusion, 'failure');
    assert.ok(stale.params.output.title.startsWith('[STALE]'));
    assert.ok(stale.params.output.text.includes(H2));

    const stored = loadChecks(join(dir, 'github-checks.json'));
    assert.equal(Object.keys(stored).length, 2);
    assert.equal(stored[`octo/hello#7#${H1}`].superseded, true);
    const events = list().filter((e) => e.type === 'check.superseded');
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, 'github-app');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github checks: fail-closed without client', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghchk-'));
  clear();
  try {
    setupRepo(dir);
    const opts = { storePath: join(dir, 'installations.json') };
    const base = { repo: 'octo/hello', prNumber: 7, headSha: H1, verdict: 'SHIP', findings: [] };
    await assert.rejects(postCheck({ ...base }, opts), /api client/);
    await assert.rejects(postCheck({ ...base, api: null }, opts), /api client/);
    await assert.rejects(postCheck({ ...base, api: {} }, opts), /api client/);
    await assert.rejects(
      postCheck({ ...base, api: { createCheckRun: async () => ({ id: 1 }) } }, opts),
      /api client/,
    );
    assert.equal(list().length, 2); // install + select only; no check events
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github checks: unknown repo ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghchk-'));
  clear();
  try {
    const { storePath } = setupRepo(dir);
    const api = makeFakeApi();
    const eventsBefore = list().length;
    const out = await postCheck(
      { api, repo: 'octo/stranger', prNumber: 9, headSha: H1, verdict: 'SHIP', findings: [] },
      { storePath },
    );
    assert.deepEqual(out, { ignored: true });
    assert.equal(api.calls.creates.length, 0);
    assert.equal(api.calls.updates.length, 0);
    assert.equal(list().length, eventsBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
