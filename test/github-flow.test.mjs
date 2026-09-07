import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clear, list } from '../lib/audit.js';
import { handleInstallation, selectRepo, captureHead, loadPrStore } from '../apps/github/store.js';
import { loadChecks } from '../apps/github/checks.js';
import { handlePullRequest } from '../apps/github/flow.js';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const B1 = 'c'.repeat(40);
const B2 = 'd'.repeat(40);

const CLEAN_DIFF = `diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
`;

// Recording fake for the injected check-runs client { createCheckRun,
// updateCheckRun }. No network, no exec: every call is captured.
function makeFakeApi() {
  const calls = { creates: [], updates: [] };
  let nextId = 500;
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

test('github flow: opened happy path wires ingest→review→check with audit order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghflow-'));
  clear();
  try {
    const { storePath } = setupRepo(dir);
    const api = makeFakeApi();
    const seen = [];
    const reviewFn = async (args) => {
      seen.push(args);
      return { verdict: 'SHIP', summary: { files: 1, added: 2, removed: 0 }, findings: [] };
    };
    const event = { action: 'opened', repo: 'octo/hello', prNumber: 7, headSha: H1, baseSha: B1, diff: CLEAN_DIFF };
    const out = await handlePullRequest({ store: { storePath }, api, event, reviewFn });

    // Return shape carries the verdict, the run id, and the exact HEAD.
    assert.deepEqual(Object.keys(out).sort(), ['checkRunId', 'headSha', 'verdict']);
    assert.equal(out.verdict, 'SHIP');
    assert.equal(out.headSha, H1);
    assert.equal(typeof out.checkRunId, 'number');

    // reviewFn saw the wired diff + identity (pure function, no shell-out).
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0], { diff: CLEAN_DIFF, repo: 'octo/hello', prNumber: 7, headSha: H1, baseSha: B1 });

    // Exactly one check-run create, no update.
    assert.equal(api.calls.creates.length, 1);
    assert.equal(api.calls.updates.length, 0);
    const created = api.calls.creates[0];
    assert.equal(created.name, 'sentinel/review');
    assert.equal(created.head_sha, H1);
    assert.equal(created.conclusion, 'success');
    assert.ok(created.output.title.includes('SHIP'));
    assert.ok(created.output.text.includes(H1) || created.output.summary.includes(H1));

    // Both registries persisted under the isolated dir.
    assert.equal(captureHead('octo/hello', 7, { storePath }), H1);
    assert.equal(loadPrStore(join(dir, 'github-prs.json'))[`octo/hello#7`].headSha, H1);
    const checks = loadChecks(join(dir, 'github-checks.json'));
    assert.equal(Object.keys(checks).length, 1);
    assert.equal(checks[`octo/hello#7#${H1}`].checkRunId, out.checkRunId);

    // Every step emitted, in wiring order, all by github-app.
    const types = list().map((e) => e.type);
    const ingestAt = types.indexOf('pr.ingested');
    const reviewAt = types.indexOf('review.computed');
    const createdAt = types.indexOf('check.created');
    assert.ok(ingestAt !== -1 && reviewAt !== -1 && createdAt !== -1);
    assert.ok(ingestAt < reviewAt && reviewAt < createdAt);
    for (const t of ['pr.ingested', 'review.computed', 'check.created']) {
      assert.equal(list().find((e) => e.type === t).actor, 'github-app');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github flow: synchronize with new HEAD creates a second run + supersedes the old', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghflow-'));
  clear();
  try {
    const { storePath } = setupRepo(dir);
    const api = makeFakeApi();
    const reviewFn = async ({ headSha }) => (
      headSha === H1
        ? { verdict: 'DO_NOT_SHIP', summary: 'eval found', findings: [finding()] }
        : { verdict: 'SHIP', summary: 'clean', findings: [] }
    );
    const first = await handlePullRequest({
      store: { storePath }, api, reviewFn,
      event: { action: 'opened', repo: 'octo/hello', prNumber: 7, headSha: H1, baseSha: B1, diff: 'd1' },
    });
    const second = await handlePullRequest({
      store: { storePath }, api, reviewFn,
      event: { action: 'synchronize', repo: 'octo/hello', prNumber: 7, headSha: H2, baseSha: B2, diff: 'd2' },
    });

    assert.equal(first.verdict, 'DO_NOT_SHIP');
    assert.equal(second.verdict, 'SHIP');
    assert.equal(second.headSha, H2);
    assert.notEqual(second.checkRunId, first.checkRunId);

    // Two creates (one per HEAD) + one supersede update of the OLD run.
    assert.equal(api.calls.creates.length, 2);
    assert.equal(api.calls.creates[1].head_sha, H2);
    assert.equal(api.calls.creates[1].conclusion, 'success');
    assert.equal(api.calls.updates.length, 1);
    const stale = api.calls.updates[0];
    assert.equal(stale.id, first.checkRunId);
    assert.equal(stale.params.conclusion, 'failure');
    assert.ok(stale.params.output.title.startsWith('[STALE]'));
    assert.ok(stale.params.output.text.includes(H2));

    const stored = loadChecks(join(dir, 'github-checks.json'));
    assert.equal(Object.keys(stored).length, 2);
    assert.equal(stored[`octo/hello#7#${H1}`].superseded, true);
    assert.equal(captureHead('octo/hello', 7, { storePath }), H2);

    // Audit order across the second delivery: invalidation → review →
    // supersede → create (all by github-app).
    const types = list().map((e) => e.type);
    const invAt = types.lastIndexOf('verdict-invalidated');
    const revAt = types.lastIndexOf('review.computed');
    const supAt = types.lastIndexOf('check.superseded');
    const creAt = types.lastIndexOf('check.created');
    assert.ok(invAt !== -1 && revAt !== -1 && supAt !== -1 && creAt !== -1);
    assert.ok(invAt < revAt && revAt < supAt && supAt < creAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github flow: same-HEAD redelivery is idempotent (no duplicate check run)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghflow-'));
  clear();
  try {
    const { storePath } = setupRepo(dir);
    const api = makeFakeApi();
    const reviewFn = async () => ({ verdict: 'SHIP', summary: 'clean', findings: [] });
    const first = await handlePullRequest({
      store: { storePath }, api, reviewFn,
      event: { action: 'opened', repo: 'octo/hello', prNumber: 7, headSha: H1, baseSha: B1, diff: CLEAN_DIFF },
    });
    const second = await handlePullRequest({
      store: { storePath }, api, reviewFn,
      event: { action: 'synchronize', repo: 'octo/hello', prNumber: 7, headSha: H1, baseSha: B1, diff: CLEAN_DIFF },
    });

    assert.equal(second.verdict, 'SHIP');
    assert.equal(second.checkRunId, first.checkRunId);
    // No duplicate run: still one create; the redelivery refreshes in place.
    assert.equal(api.calls.creates.length, 1);
    assert.equal(api.calls.updates.length, 1);
    assert.equal(api.calls.updates[0].id, first.checkRunId);
    assert.equal(Object.keys(loadChecks(join(dir, 'github-checks.json'))).length, 1);
    // Ingest stays silent on same-head redelivery (store contract): one
    // pr.ingested total, one check.updated for the refresh.
    assert.equal(list().filter((e) => e.type === 'pr.ingested').length, 1);
    assert.equal(list().filter((e) => e.type === 'check.updated').length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github flow: malformed SHA throws fail-closed before any api call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghflow-'));
  clear();
  try {
    const { storePath } = setupRepo(dir);
    const api = makeFakeApi();
    let reviewCalls = 0;
    const reviewFn = () => {
      reviewCalls += 1;
      return { verdict: 'SHIP', findings: [] };
    };
    const bad = ['', 'abc', 'z'.repeat(40), H1.slice(0, 39), null, undefined, 12345];
    for (const sha of bad) {
      await assert.rejects(
        handlePullRequest({
          store: { storePath }, api, reviewFn,
          event: { action: 'opened', repo: 'octo/hello', prNumber: 7, headSha: sha, baseSha: B1 },
        }),
        /40-hex/,
      );
      await assert.rejects(
        handlePullRequest({
          store: { storePath }, api, reviewFn,
          event: { action: 'synchronize', repo: 'octo/hello', prNumber: 7, headSha: H1, baseSha: sha },
        }),
        /40-hex/,
      );
    }
    // Zero api calls, review never ran, nothing persisted.
    assert.equal(api.calls.creates.length, 0);
    assert.equal(api.calls.updates.length, 0);
    assert.equal(reviewCalls, 0);
    assert.deepEqual(loadChecks(join(dir, 'github-checks.json')), {});
    assert.equal(captureHead('octo/hello', 7, { storePath }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github flow: unknown repo is ignored without review or api calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghflow-'));
  clear();
  try {
    const { storePath } = setupRepo(dir);
    const eventsBefore = list().length;
    const api = makeFakeApi();
    let reviewCalls = 0;
    const reviewFn = () => {
      reviewCalls += 1;
      return { verdict: 'SHIP', findings: [] };
    };
    const out = await handlePullRequest({
      store: { storePath }, api, reviewFn,
      event: { action: 'opened', repo: 'octo/stranger', prNumber: 9, headSha: H1, baseSha: B1, diff: CLEAN_DIFF },
    });
    assert.deepEqual(out, { ignored: true });
    assert.equal(reviewCalls, 0);
    assert.equal(api.calls.creates.length, 0);
    assert.equal(api.calls.updates.length, 0);
    assert.equal(list().length, eventsBefore);
    assert.equal(captureHead('octo/stranger', 9, { storePath }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
