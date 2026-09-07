import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clear, list } from '../lib/audit.js';
import {
  handleInstallation,
  selectRepo,
  ingestPR,
  captureHead,
  loadPrStore,
  getInstallation,
} from '../apps/github/store.js';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const B1 = 'c'.repeat(40);
const B2 = 'd'.repeat(40);

function setupInstall(dir, id = 123, login = 'octo') {
  const storePath = join(dir, 'installations.json');
  handleInstallation(
    { action: 'created', installation: { id, account: { login } }, repositories: [] },
    { storePath },
  );
  return { storePath };
}

function opts(dir) {
  return { storePath: join(dir, 'installations.json') };
}

test('github ingest: select+ingest happy path captures HEAD', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghing-'));
  clear();
  try {
    setupInstall(dir);
    const before = list().length;
    const linked = selectRepo(123, 'octo/hello', opts(dir));
    assert.ok(linked.repos.includes('octo/hello'));
    assert.deepEqual(getInstallation(123, join(dir, 'installations.json')).repos, ['octo/hello']);

    const rec = ingestPR({ repo: 'octo/hello', prNumber: 7, headSha: H1, baseSha: B1 }, opts(dir));
    assert.equal(rec.repo, 'octo/hello');
    assert.equal(rec.prNumber, 7);
    assert.equal(rec.headSha, H1);
    assert.equal(rec.baseSha, B1);
    assert.equal(typeof rec.ingestedAt, 'string');
    assert.deepEqual(Object.keys(rec).sort(), ['baseSha', 'headSha', 'ingestedAt', 'prNumber', 'repo']);

    assert.equal(captureHead('octo/hello', 7, opts(dir)), H1);
    // Every mutation emitted audit events.
    assert.ok(list().length > before);
    assert.ok(list().some((e) => e.actor === 'github-app'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github ingest: same-headSha redelivery is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghing-'));
  clear();
  try {
    setupInstall(dir);
    selectRepo(123, 'octo/hello', opts(dir));
    const first = ingestPR({ repo: 'octo/hello', prNumber: 7, headSha: H1, baseSha: B1 }, opts(dir));
    const eventsAfterFirst = list().length;
    const second = ingestPR({ repo: 'octo/hello', prNumber: 7, headSha: H1, baseSha: B1 }, opts(dir));
    assert.deepEqual(second, first);
    assert.equal(second.ingestedAt, first.ingestedAt);
    assert.equal(Object.keys(loadPrStore(join(dir, 'github-prs.json'))).length, 1);
    // No mutation on redelivery: no new audit event, no invalidation.
    assert.equal(list().length, eventsAfterFirst);
    assert.equal(list().filter((e) => e.type.includes('invalidat')).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github ingest: malformed SHAs reject fail-closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghing-'));
  clear();
  try {
    setupInstall(dir);
    selectRepo(123, 'octo/hello', opts(dir));
    const bad = ['', 'abc', 'z'.repeat(40), H1.slice(0, 39), `${H1}x`.slice(0, 41), null, undefined, 12345];
    for (const sha of bad) {
      assert.throws(
        () => ingestPR({ repo: 'octo/hello', prNumber: 7, headSha: sha, baseSha: B1 }, opts(dir)),
        /40-hex/,
      );
      assert.throws(
        () => ingestPR({ repo: 'octo/hello', prNumber: 7, headSha: H1, baseSha: sha }, opts(dir)),
        /40-hex/,
      );
    }
    assert.throws(() => selectRepo(999, 'octo/hello', opts(dir)), /unknown installation/);
    // Nothing persisted, HEAD uncaptured.
    assert.deepEqual(loadPrStore(join(dir, 'github-prs.json')), {});
    assert.equal(captureHead('octo/hello', 7, opts(dir)), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github ingest: HEAD move updates the record + emits verdict-invalidated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghing-'));
  clear();
  try {
    setupInstall(dir);
    selectRepo(123, 'octo/hello', opts(dir));
    const first = ingestPR({ repo: 'octo/hello', prNumber: 7, headSha: H1, baseSha: B1 }, opts(dir));
    const moved = ingestPR({ repo: 'octo/hello', prNumber: 7, headSha: H2, baseSha: B2 }, opts(dir));
    // Old verdict's SHA is gone: record tracks the new HEAD, never the old.
    assert.equal(moved.headSha, H2);
    assert.equal(moved.baseSha, B2);
    assert.notEqual(moved.headSha, first.headSha);
    assert.equal(captureHead('octo/hello', 7, opts(dir)), H2);
    assert.equal(Object.keys(loadPrStore(join(dir, 'github-prs.json'))).length, 1);
    const inv = list().filter((e) => e.type.includes('invalidat'));
    assert.equal(inv.length, 1);
    assert.ok(inv[0].type.includes('verdict'));
    assert.equal(inv[0].actor, 'github-app');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github ingest: unknown-repo events are ignored without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghing-'));
  clear();
  try {
    setupInstall(dir);
    selectRepo(123, 'octo/hello', opts(dir));
    const eventsBefore = list().length;
    const out = ingestPR({ repo: 'octo/stranger', prNumber: 9, headSha: H1, baseSha: B1 }, opts(dir));
    assert.deepEqual(out, { ignored: true });
    assert.equal(captureHead('octo/stranger', 9, opts(dir)), null);
    // Ignored events mutate nothing and audit nothing.
    assert.equal(list().length, eventsBefore);
    assert.deepEqual(loadPrStore(join(dir, 'github-prs.json')), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
