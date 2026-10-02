// Delivery-recovery and transport-hardening regressions.
//
// Each test here pins a failure mode found in the 2026-10-02 audit of the
// deployed revision 0f76562. Every one of them was reachable in production and
// all of them fail silently — a lost review, a poisoned token cache, or a
// duplicate comment — which is why they had no test coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { createHandler } from '../apps/github/app.js';
import { createPlatform } from '../apps/github/platform.js';

const SECRET = 'delivery-recovery-secret';

function sign(raw, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

function tmpOpts(dir) {
  return {
    ledgerPath: join(dir, 'ledger.jsonl'),
    memoryPath: join(dir, 'mem.jsonl'),
    storePath: join(dir, 'installations.json'),
  };
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

async function post(base, body, delivery, secret = SECRET) {
  const raw = Buffer.from(body);
  const res = await fetch(`${base}/webhooks/github`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': sign(raw, secret),
      'x-github-event': 'workflow_run',
      'x-github-delivery': delivery,
    },
    body: raw,
  });
  return { status: res.status, text: await res.text() };
}

// A completed workflow_run attached to a PR reaches platform.getPR, which is
// the cheapest injection point for forcing a mid-handler failure.
const FAILING_PAYLOAD = JSON.stringify({
  action: 'completed',
  workflow_run: { head_sha: 'a'.repeat(40), pull_requests: [{ number: 7 }] },
  repository: { full_name: 'o/r' },
});

function countingFailingPlatform(counter) {
  return {
    getPR() { counter.calls += 1; throw new Error('transient upstream failure'); },
  };
}

// Regression: a delivery id was recorded BEFORE processing and never rolled
// back. GitHub retries a failed delivery with the SAME X-GitHub-Delivery id, so
// the retry hit the dedupe branch, returned 200, and GitHub marked a PR that
// was never reviewed as successfully delivered.
test('a failed delivery is retried, not swallowed by the dedupe cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-delivery-'));
  try {
    const counter = { calls: 0 };
    const handler = createHandler({
      platform: countingFailingPlatform(counter),
      secret: SECRET,
      opts: tmpOpts(dir),
    });
    await withServer(handler, async (base) => {
      const first = await post(base, FAILING_PAYLOAD, 'delivery-fixed-guid-1');
      assert.equal(first.status, 500, 'first attempt fails');

      const retry = await post(base, FAILING_PAYLOAD, 'delivery-fixed-guid-1');
      assert.equal(retry.status, 500, 'the retry must be handled again, not deduped to 200');
      assert.doesNotMatch(retry.text, /duplicate-delivery/);
      assert.equal(counter.calls, 2, 'the retry reached the platform a second time');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The idempotence contract itself must survive the fix: a delivery that
// SUCCEEDED is still deduplicated on replay.
test('a successful delivery is still deduplicated on replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-delivery-ok-'));
  try {
    const counter = { calls: 0 };
    const platform = {
      getPR: async () => ({ head: { sha: 'a'.repeat(40) } }),
      getDiff: async () => '',
    };
    const handler = createHandler({ platform, secret: SECRET, opts: tmpOpts(dir) });
    await withServer(handler, async (base) => {
      const first = await post(base, FAILING_PAYLOAD, 'delivery-fixed-guid-2');
      assert.equal(first.status, 200);
      const replay = await post(base, FAILING_PAYLOAD, 'delivery-fixed-guid-2');
      assert.equal(replay.status, 200);
      assert.match(replay.text, /duplicate-delivery/);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: rawReq threw on any !res.ok including 401, and the token cache
// was only refreshed on TTL. One revoked/early-expired token 500'd every
// webhook for up to ~59 minutes with no invalidation and no retry.
test('a 401 invalidates the cached installation token and retries once', async () => {
  const mintCalls = { n: 0 };
  const authed = { n: 0 };
  const fetchImpl = async (url) => {
    if (url.includes('/app/installations/') && url.includes('access_tokens')) {
      mintCalls.n += 1;
      return json({ token: `token-${mintCalls.n}`, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (url.includes('/app/installations')) {
      return json([{ id: 1, account: { login: 'Aftergraph' } }]);
    }
    authed.n += 1;
    if (authed.n === 1) return json({ message: 'Bad credentials' }, 401);
    return json({ ok: true, recovered: true });
  };
  const platform = createPlatform({
    appId: '5144112',
    privateKeyPem: testPem(),
    fetchImpl,
    sleepImpl: async () => {},
  });
  const out = await platform.getPR('o/r', 7);
  assert.deepEqual(out, { ok: true, recovered: true }, 'the retry after re-minting succeeded');
  assert.equal(mintCalls.n, 2, 'a fresh installation token was minted');
  assert.equal(authed.n, 2, 'exactly one retry, not a loop');
});

// Regression: installs[0] was taken blindly. With the App on more than one org
// the app silently bound to whichever GitHub returned first.
test('multiple installations fail closed instead of binding to the first', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/app/installations')) {
      return json([
        { id: 1, account: { login: 'Aftergraph' } },
        { id: 2, account: { login: 'OtherOrg' } },
      ]);
    }
    return json({ token: 't', expires_at: new Date(Date.now() + 3600_000).toISOString() });
  };
  const platform = createPlatform({
    appId: '5144112', privateKeyPem: testPem(), fetchImpl, sleepImpl: async () => {},
  });
  await assert.rejects(() => platform.getPR('o/r', 7), /expected exactly 1 installation/);
});

// Regression: fetch had no AbortSignal, so a hung connection held the webhook
// open indefinitely.
test('a hung upstream is aborted rather than holding the request open', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const platform = createPlatform({
    token: 'pat', fetchImpl, timeoutMs: 30, maxRetries: 0, sleepImpl: async () => {},
  });
  await assert.rejects(() => platform.getPR('o/r', 7), /timeout after 30ms/);
});

// Transient upstream statuses get a bounded retry instead of failing the review.
test('a 503 is retried and then succeeds', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n += 1;
    if (n === 1) return json({ message: 'Service unavailable' }, 503);
    return json({ ok: true });
  };
  const platform = createPlatform({ token: 'pat', fetchImpl, sleepImpl: async () => {} });
  const out = await platform.getPR('o/r', 7);
  assert.deepEqual(out, { ok: true });
  assert.equal(n, 2);
});

// A 404 must NOT be retried — it is deterministic and a retry would mask it.
test('a 404 fails immediately without retrying', async () => {
  let n = 0;
  const fetchImpl = async () => { n += 1; return json({ message: 'Not Found' }, 404); };
  const platform = createPlatform({ token: 'pat', fetchImpl, sleepImpl: async () => {} });
  await assert.rejects(() => platform.getPR('o/r', 7), /: 404/);
  assert.equal(n, 1);
});

// Regression: listComments read only the first 100, so on a busy PR our own
// <!-- sentinel-verdict --> card fell outside the window and a second top-level
// comment was posted, breaking the one-card-per-PR contract.
test('listComments pages past the first 100 comments', async () => {
  const pages = [];
  const fetchImpl = async (url) => {
    const page = Number(new URL(url).searchParams.get('page') || '1');
    pages.push(page);
    if (page === 1) return json(Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'noise' })));
    if (page === 2) return json([{ id: 999, body: '<!-- sentinel-verdict --> ours' }]);
    return json([]);
  };
  const platform = createPlatform({ token: 'pat', fetchImpl });
  const comments = await platform.listComments('o/r', 7);
  assert.equal(comments.length, 101, 'the second page was read');
  assert.ok(comments.some((c) => c.body.includes('sentinel-verdict')));
  assert.deepEqual(pages, [1, 2], 'stopped once a short page was returned, no wasted third call');
});

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// A throwaway RSA key generated per run, matching the existing
// test/github-app-auth.test.mjs convention. No key material is committed —
// these tests only exercise the signing and caching paths against a mocked
// transport, so the key never authenticates anything.
function testPem() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey;
}
