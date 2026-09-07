import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { clear, list } from '../lib/audit.js';
import { createHandler } from '../apps/github/app.js';

const SECRET = 'webhook-test-secret';

// Platform that must never be touched by these paths: any access throws,
// so a call surfaces as a 500 instead of silently passing.
function untouchedPlatform(counter) {
  return new Proxy({}, {
    get: () => (...args) => {
      counter.calls += 1;
      throw new Error(`platform must not be touched (got ${args.length} args)`);
    },
  });
}

function tmpOpts(dir) {
  return {
    ledgerPath: join(dir, 'ledger.jsonl'),
    memoryPath: join(dir, 'mem.jsonl'),
    storePath: join(dir, 'installations.json'),
  };
}

function sign(raw, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

async function post(base, { body = '{}', secret = SECRET, event = 'pull_request', rawSig, omitSig = false, path = '/webhooks/github', method = 'POST' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (!omitSig) headers['x-hub-signature-256'] = rawSig ?? sign(Buffer.from(body ?? ''), secret);
  if (event !== null) headers['x-github-event'] = event;
  const init = { method, headers };
  if (method !== 'GET' && body !== null) init.body = body;
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, text, nosniff: res.headers.get('x-content-type-options') };
}

test('github webhook: missing signature is 401 with zero side effects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghwh-'));
  clear();
  const counter = { calls: 0 };
  const before = list().length;
  try {
    const handler = createHandler({ platform: untouchedPlatform(counter), secret: SECRET, opts: tmpOpts(dir) });
    await withServer(handler, async (base) => {
      const res = await post(base, { omitSig: true });
      assert.equal(res.status, 401);
      assert.equal(res.nosniff, 'nosniff');
      assert.match(res.text, /bad signature/);
      assert.ok(!res.text.includes(SECRET), 'error must not leak the secret');
      assert.equal(counter.calls, 0);
      assert.equal(list().length, before);
      assert.deepEqual(readdirSync(dir), [], 'no store/ledger files written');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github webhook: wrong secret is 401 with zero platform calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghwh-'));
  clear();
  const counter = { calls: 0 };
  const before = list().length;
  try {
    const handler = createHandler({ platform: untouchedPlatform(counter), secret: SECRET, opts: tmpOpts(dir) });
    await withServer(handler, async (base) => {
      const body = JSON.stringify({ zen: 'keep it simple' });
      const res = await post(base, { body, secret: 'wrong-secret', event: 'ping' });
      assert.equal(res.status, 401);
      assert.ok(!res.text.includes(SECRET) && !res.text.includes('wrong-secret'));
      assert.equal(counter.calls, 0);
      assert.equal(list().length, before);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github webhook: undefined secret fails closed per request (401, no throw)', async () => {
  // Existing contract: createHandler does not throw on a missing secret —
  // verifySignature() returns false, so every delivery is a 401.
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghwh-'));
  clear();
  const counter = { calls: 0 };
  try {
    const handler = createHandler({ platform: untouchedPlatform(counter), secret: undefined, opts: tmpOpts(dir) });
    await withServer(handler, async (base) => {
      const body = JSON.stringify({ zen: 'x' });
      const res = await post(base, { body, event: 'ping' });
      assert.equal(res.status, 401);
      assert.equal(counter.calls, 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github webhook: signature is checked over the raw body before JSON parsing', async () => {
  // Unparseable body + bad signature must be 401, never a 500 from the parser.
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghwh-'));
  clear();
  const counter = { calls: 0 };
  try {
    const handler = createHandler({ platform: untouchedPlatform(counter), secret: SECRET, opts: tmpOpts(dir) });
    await withServer(handler, async (base) => {
      const res = await post(base, { body: 'not-json{{{', rawSig: 'sha256=0' });
      assert.equal(res.status, 401);
      assert.equal(counter.calls, 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github webhook: ping returns 200 pong without touching the platform', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghwh-'));
  clear();
  const counter = { calls: 0 };
  try {
    const handler = createHandler({ platform: untouchedPlatform(counter), secret: SECRET, opts: tmpOpts(dir) });
    await withServer(handler, async (base) => {
      const body = JSON.stringify({ zen: 'keep it simple' });
      const res = await post(base, { body, event: 'ping' });
      assert.equal(res.status, 200);
      assert.equal(res.nosniff, 'nosniff');
      assert.deepEqual(JSON.parse(res.text), { ok: true, handled: true, action: 'pong' });
      assert.equal(counter.calls, 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github webhook: unknown event returns 200 ignored with zero platform calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghwh-'));
  clear();
  const counter = { calls: 0 };
  const before = list().length;
  try {
    const handler = createHandler({ platform: untouchedPlatform(counter), secret: SECRET, opts: tmpOpts(dir) });
    await withServer(handler, async (base) => {
      const body = JSON.stringify({ action: 'created' });
      const res = await post(base, { body, event: 'star' });
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.text), { ok: true, handled: false, action: 'ignored:star' });
      assert.equal(counter.calls, 0);
      assert.equal(list().length, before);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github webhook: wrong method and path are 404 before any body/signature work', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghwh-'));
  clear();
  const counter = { calls: 0 };
  try {
    const handler = createHandler({ platform: untouchedPlatform(counter), secret: SECRET, opts: tmpOpts(dir) });
    await withServer(handler, async (base) => {
      // No signature at all: the router rejects before reading the body.
      const get = await post(base, { method: 'GET', body: null, omitSig: true });
      assert.equal(get.status, 404);
      const wrongPath = await post(base, { path: '/nope', omitSig: true });
      assert.equal(wrongPath.status, 404);
      assert.equal(counter.calls, 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github webhook: valid signature with malformed JSON is 500 without leaking the secret', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghwh-'));
  clear();
  const counter = { calls: 0 };
  try {
    const handler = createHandler({ platform: untouchedPlatform(counter), secret: SECRET, opts: tmpOpts(dir) });
    await withServer(handler, async (base) => {
      const res = await post(base, { body: 'not-json{{{' });
      assert.equal(res.status, 500);
      assert.ok(!res.text.includes(SECRET), 'error must not leak the secret');
      assert.equal(counter.calls, 0);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github webhook: malformed installation payload is 500 with nothing persisted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghwh-'));
  clear();
  const counter = { calls: 0 };
  const before = list().length;
  try {
    const handler = createHandler({ platform: untouchedPlatform(counter), secret: SECRET, opts: tmpOpts(dir) });
    await withServer(handler, async (base) => {
      const res = await post(base, { body: '{}', event: 'installation' });
      assert.equal(res.status, 500);
      assert.match(res.text, /payload\.installation/);
      assert.ok(!res.text.includes(SECRET));
      assert.equal(counter.calls, 0);
      assert.equal(list().length, before);
      assert.deepEqual(readdirSync(dir), [], 'failed install writes no store file');
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github webhook: oversize body is never processed and the server stays up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghwh-'));
  clear();
  const counter = { calls: 0 };
  const before = list().length;
  try {
    const handler = createHandler({ platform: untouchedPlatform(counter), secret: SECRET, opts: tmpOpts(dir) });
    await withServer(handler, async (base) => {
      // Just under the 1MB cap: a large but legal ping still passes.
      const room = 1024 * 1024 - 64;
      const big = JSON.stringify({ zen: 'x'.repeat(room) });
      assert.ok(Buffer.byteLength(big) < 1024 * 1024);
      const ok = await post(base, { body: big, event: 'ping' });
      assert.equal(ok.status, 200);

      // Over the cap: the existing handler destroys the socket (client sees
      // a transport failure) instead of returning a status — either way the
      // delivery must never reach the platform, audit log, or disk.
      const huge = `{"zen":"${'y'.repeat(1024 * 1024 + 16)}"}`;
      const sig = sign(Buffer.from(huge));
      let settled;
      try {
        const res = await fetch(`${base}/webhooks/github`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig, 'x-github-event': 'ping' },
          body: huge,
        });
        settled = { status: res.status, text: await res.text() };
        assert.ok(settled.status === 500, `expected 500, got ${settled.status}`);
      } catch {
        settled = { transportFailed: true };
      }
      assert.ok(settled.transportFailed === true || settled.status === 500);
      assert.equal(counter.calls, 0);
      assert.equal(list().length, before);

      // The oversized socket teardown is per-connection: the server is fine.
      const after = await post(base, { body: JSON.stringify({ zen: 'x' }), event: 'ping' });
      assert.equal(after.status, 200);
      assert.deepEqual(JSON.parse(after.text), { ok: true, handled: true, action: 'pong' });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
