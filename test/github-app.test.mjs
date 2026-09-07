import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { verifySignature } from '../apps/github/verify.js';
import { renderCard, findOwnComment, CARD_MARKER } from '../apps/github/card.js';
import { routeEvent, createHandler } from '../apps/github/app.js';
import { createPlatform } from '../apps/github/platform.js';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const B = 'c'.repeat(40);

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

function mockPlatform({ heads = [H1], diff = CLEAN_DIFF, comments = [] } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    async getPR() {
      calls.push('getPR');
      return { head: { sha: heads[Math.min(n++, heads.length - 1)] }, base: { sha: B } };
    },
    async getDiff() { calls.push('getDiff'); return diff; },
    async listComments() { calls.push('listComments'); return comments; },
    async postComment(repo, pr, body) { calls.push(['post', body]); return { id: 1 }; },
    async patchComment(repo, id, body) { calls.push(['patch', id, body]); return { id }; },
  };
}

function payload(action = 'opened') {
  return { action, repository: { full_name: 'o/r' }, pull_request: { number: 7 } };
}

function tmpOpts(dir) {
  return { ledgerPath: join(dir, 'ledger.jsonl'), memoryPath: join(dir, 'mem.jsonl') };
}

test('github: webhook signatures verify', () => {
  const secret = 's3cret';
  const body = Buffer.from('{"a":1}');
  const good = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifySignature(body, good, secret), true);
  assert.equal(verifySignature(body, 'sha256=deadbeef', secret), false);
  assert.equal(verifySignature(body, good, 'wrong'), false);
  assert.equal(verifySignature(body, null, secret), false);
});

test('github: card renders verdicts with marker', () => {
  const base = {
    headSha: H1, baseSha: B, rulePackVersion: '1.1.0',
    summary: { files: 1, added: 1, removed: 0 },
    silenced: [], nonBlocking: [], receiptId: 'abc123',
  };
  const ship = renderCard({ ...base, verdict: 'SHIP', blocking: [] });
  assert.ok(ship.includes(CARD_MARKER));
  assert.ok(ship.includes('● SHIP'));
  assert.ok(ship.includes('Receipt `abc123`'));

  const bad = renderCard({
    ...base, verdict: 'DO_NOT_SHIP',
    blocking: [{ ruleId: 'r', file: 'a.js', line: 1, evidence: 'e' }],
  });
  assert.ok(bad.includes('● DO NOT SHIP'));
  assert.ok(bad.includes('[r]'));

  const stale = renderCard({ ...base, verdict: 'STALE', blocking: [], staleReason: 'head moved' });
  assert.ok(stale.includes('● STALE'));
  assert.ok(stale.includes('head moved'));

  const many = renderCard({
    ...base, verdict: 'DO_NOT_SHIP',
    blocking: Array.from({ length: 25 }, (_, i) => ({ ruleId: 'r', file: 'a.js', line: i, evidence: 'e' })),
  });
  assert.ok(many.includes('…and 5 more'));
});

test('github: card sanitizes evidence for markdown', () => {
  const card = renderCard({
    verdict: 'DO_NOT_SHIP', headSha: H1, baseSha: B, rulePackVersion: '1.1.0',
    summary: null, silenced: [],
    blocking: [{ ruleId: 'r', file: 'a.js', line: 1, evidence: 'x```\n injected fence ' + 'y'.repeat(500) }],
  });
  assert.ok(!card.includes('```'));
  assert.ok(card.length < 2000);
});

test('github: own-comment selector', () => {
  const mine = { id: 9, body: `hello\n${CARD_MARKER}\nbye` };
  assert.equal(findOwnComment([{ id: 1, body: 'other' }, mine]).id, 9);
  assert.equal(findOwnComment([{ id: 1, body: 'other' }]), null);
  assert.equal(findOwnComment([]), null);
});

test('github: opened PR creates a SHIP card', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-gh-'));
  try {
    const platform = mockPlatform();
    const out = await routeEvent({ event: 'pull_request', payload: payload('opened'), platform, opts: tmpOpts(dir) });
    assert.equal(out.action, 'created');
    assert.equal(out.verdict, 'SHIP');
    const posted = platform.calls.find((c) => Array.isArray(c) && c[0] === 'post');
    assert.ok(posted[1].includes('● SHIP'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github: dirty diff creates DO_NOT_SHIP card', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-gh-'));
  try {
    const platform = mockPlatform({ diff: EVAL_DIFF });
    const out = await routeEvent({ event: 'pull_request', payload: payload('opened'), platform, opts: tmpOpts(dir) });
    assert.equal(out.verdict, 'DO_NOT_SHIP');
    const posted = platform.calls.find((c) => Array.isArray(c) && c[0] === 'post');
    assert.ok(posted[1].includes('no-eval-with-dynamic-input'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github: synchronize updates the existing card in place', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-gh-'));
  try {
    const own = { id: 42, body: `${CARD_MARKER}\nold` };
    const platform = mockPlatform({ diff: EVAL_DIFF, comments: [{ id: 1, body: 'human' }, own] });
    const out = await routeEvent({ event: 'pull_request', payload: payload('synchronize'), platform, opts: tmpOpts(dir) });
    assert.equal(out.action, 'updated');
    const patched = platform.calls.find((c) => Array.isArray(c) && c[0] === 'patch');
    assert.equal(patched[1], 42);
    assert.ok(!platform.calls.some((c) => Array.isArray(c) && c[0] === 'post'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github: moved HEAD posts a STALE card, never a verdict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-gh-'));
  try {
    const platform = mockPlatform({ heads: [H1, H2], diff: CLEAN_DIFF });
    const out = await routeEvent({ event: 'pull_request', payload: payload('synchronize'), platform, opts: tmpOpts(dir) });
    assert.equal(out.verdict, 'STALE');
    const posted = platform.calls.find((c) => Array.isArray(c) && c[0] === 'post');
    assert.ok(posted[1].includes('● STALE'));
    assert.ok(!posted[1].includes('● SHIP'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github: non-PR events and closed actions are ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-gh-'));
  try {
    const platform = mockPlatform();
    assert.equal((await routeEvent({ event: 'ping', payload: {}, platform, opts: tmpOpts(dir) })).action, 'pong');
    assert.equal((await routeEvent({ event: 'issues', payload: {}, platform, opts: tmpOpts(dir) })).handled, false);
    const closed = await routeEvent({ event: 'pull_request', payload: payload('closed'), platform, opts: tmpOpts(dir) });
    assert.equal(closed.handled, false);
    assert.ok(!platform.calls.includes('getDiff'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github: platform client maps HTTP shapes', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push([init.method, url]);
    const json = (obj) => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => obj });
    if (url.endsWith('/pulls/7')) return json({ head: { sha: H1 }, base: { sha: B } });
    if (url.includes('/comments')) return json([{ id: 1 }]);
    throw new Error(`unexpected ${url}`);
  };
  const p = createPlatform({ token: 't', fetchImpl: fakeFetch });
  await p.getPR('o/r', 7);
  await p.listComments('o/r', 7);
  assert.deepEqual(seen.map((s) => s[0]), ['GET', 'GET']);
  const errFetch = async () => ({ ok: false, status: 403, headers: { get: () => '' } });
  const p2 = createPlatform({ token: 't', fetchImpl: errFetch });
  await assert.rejects(() => p2.getPR('o/r', 7), /403/);
});

test('github: HTTP handler enforces signatures end to end', async () => {
  const { createServer } = await import('node:http');
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-gh-'));
  try {
    const platform = mockPlatform();
    const secret = 'test-secret';
    const handler = createHandler({ platform, secret, opts: tmpOpts(dir) });
    const server = createServer(handler);
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    try {
      const body = JSON.stringify(payload('opened'));
      const sig = `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`;
      const good = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig, 'x-github-event': 'pull_request' },
        body,
      });
      assert.equal(good.status, 200);
      assert.equal(good.headers.get('x-content-type-options'), 'nosniff');
      assert.equal((await good.json()).verdict, 'SHIP');
      const bad = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=0', 'x-github-event': 'pull_request' },
        body,
      });
      assert.equal(bad.status, 401);
    } finally {
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
