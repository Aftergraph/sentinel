import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createConsoleServer, createRateLimiter } from '../console/server.js';
import { ruleIdsForPack, RULE_PACK_VERSION } from '../lib/rulepack.js';

async function boot(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-console-rl-'));
  const handler = createConsoleServer({
    ledgerPath: join(dir, 'ledger.jsonl'),
    memoryPath: join(dir, 'mem.jsonl'),
    // Hermetic: never discover cwd config (a stray file would poison results).
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
      return { status: res.status, headers: res.headers, json: await res.json(), text: null };
    },
    async raw(method, path, body, headers = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON */ }
      return { status: res.status, headers: res.headers, json, text };
    },
    async close() {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('ratelimit: over-limit returns 429 with Retry-After and fixed error body', async () => {
  const c = await boot({ rateLimit: { windowMs: 60000, max: 2 }, noExemptLoopback: true });
  try {
    assert.equal((await c.call('GET', '/api/rules')).status, 200);
    assert.equal((await c.call('GET', '/api/rules')).status, 200);
    // 3rd hit in the window is over the max of 2.
    const r = await c.raw('POST', '/api/verify', { marker: 'UNIQUE-MARKER-9f8e7d6c5b' });
    assert.equal(r.status, 429);
    const retryAfter = r.headers.get('retry-after');
    assert.ok(retryAfter !== null, 'Retry-After header must be present');
    assert.ok(Number.isInteger(Number(retryAfter)) && Number(retryAfter) >= 1, 'Retry-After must be a positive integer');
    assert.deepEqual(r.json, { error: 'rate limited' });
    // 429 body must not echo request content.
    assert.ok(!r.text.includes('UNIQUE-MARKER-9f8e7d6c5b'), '429 body must not echo request body');
    assert.ok(!r.text.includes('/api/verify'), '429 body must not echo request path');
  } finally { await c.close(); }
});

test('ratelimit: healthz is never limited', async () => {
  const c = await boot({ rateLimit: { windowMs: 60000, max: 2 }, noExemptLoopback: true });
  try {
    await c.call('GET', '/api/rules');
    await c.call('GET', '/api/rules');
    assert.equal((await c.call('GET', '/api/rules')).status, 429);
    // Healthz still serves, repeatedly, while the bucket is exhausted.
    for (let i = 0; i < 5; i += 1) {
      const h = await c.call('GET', '/api/healthz');
      assert.equal(h.status, 200);
      assert.equal(h.json.ok, true);
    }
  } finally { await c.close(); }
});

test('ratelimit: loopback is exempt by default', async () => {
  const c = await boot({ rateLimit: { windowMs: 60000, max: 2 } });
  try {
    // 10 loopback hits with max 2 would 429 without the exemption.
    for (let i = 0; i < 10; i += 1) {
      const r = await c.call('GET', '/api/rules');
      assert.equal(r.status, 200);
      assert.equal(r.json.rules.length, ruleIdsForPack(RULE_PACK_VERSION).length);
    }
  } finally { await c.close(); }
});

test('ratelimit: noExemptLoopback disables the loopback exemption', async () => {
  const c = await boot({ rateLimit: { windowMs: 60000, max: 2 }, noExemptLoopback: true });
  try {
    assert.equal((await c.call('GET', '/api/rules')).status, 200);
    assert.equal((await c.call('GET', '/api/rules')).status, 200);
    assert.equal((await c.call('GET', '/api/rules')).status, 429);
  } finally { await c.close(); }
});

test('ratelimit: counters reset per window', async () => {
  const c = await boot({ rateLimit: { windowMs: 150, max: 1 }, noExemptLoopback: true });
  try {
    assert.equal((await c.call('GET', '/api/rules')).status, 200);
    assert.equal((await c.call('GET', '/api/rules')).status, 429);
    await sleep(300);
    assert.equal((await c.call('GET', '/api/rules')).status, 200);
  } finally { await c.close(); }
});

test('ratelimit: token gate still 401s correctly under limits', async () => {
  const c = await boot({
    token: 'tok',
    rateLimit: { windowMs: 60000, max: 2 },
    noExemptLoopback: true,
  });
  const auth = { authorization: 'Bearer tok' };
  try {
    assert.equal((await c.call('GET', '/api/rules', undefined, auth)).status, 200);
    assert.equal((await c.call('GET', '/api/rules', undefined, auth)).status, 200);
    // Budget exhausted: authed callers now get 429 ...
    assert.equal((await c.call('GET', '/api/rules', undefined, auth)).status, 429);
    // ... but the gate still answers 401 (not 429) for bad credentials.
    assert.equal((await c.call('GET', '/api/rules')).status, 401);
    assert.equal((await c.call('GET', '/api/rules', undefined, { authorization: 'Bearer wrong' })).status, 401);
  } finally { await c.close(); }
});

test('ratelimit: failed-auth hits count toward the budget', async () => {
  const c = await boot({
    token: 'tok',
    rateLimit: { windowMs: 60000, max: 2 },
    noExemptLoopback: true,
  });
  const auth = { authorization: 'Bearer tok' };
  try {
    // Two unauthenticated hits consume the whole budget (both 401).
    assert.equal((await c.call('GET', '/api/rules')).status, 401);
    assert.equal((await c.call('GET', '/api/rules')).status, 401);
    // The next authed hit is over budget.
    assert.equal((await c.call('GET', '/api/rules', undefined, auth)).status, 429);
  } finally { await c.close(); }
});

test('ratelimit unit: buckets are isolated per IP with no header input', async () => {
  const rl = createRateLimiter({ windowMs: 60000, max: 1 });
  const t = 1000000;
  assert.deepEqual(rl.check('10.0.0.1', t), { limited: false, retryAfter: 0 });
  // Same IP over budget ...
  const over = rl.check('10.0.0.1', t + 1);
  assert.equal(over.limited, true);
  assert.ok(over.retryAfter >= 1);
  // ... while a different IP is unaffected (keyed by IP string only —
  // the helper takes no headers, so nothing can leak cross-IP).
  assert.deepEqual(rl.check('10.0.0.2', t + 1), { limited: false, retryAfter: 0 });
  assert.equal(rl.size, 2);
});

test('ratelimit unit: window expiry resets counters and sweeps memory', async () => {
  const rl = createRateLimiter({ windowMs: 100, max: 1 });
  const t = 2000000;
  assert.equal(rl.check('10.0.0.1', t).limited, false);
  assert.equal(rl.check('10.0.0.2', t).limited, false);
  assert.equal(rl.size, 2);
  // Past the window both buckets are swept and counting restarts.
  assert.equal(rl.check('10.0.0.1', t + 101).limited, false);
  assert.equal(rl.size, 1);
});
