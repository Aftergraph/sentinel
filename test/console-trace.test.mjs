// Request-id tracing for the Sentinel console (observability, additive).
//
// Policy under test (see resolveRequestId + handler frame in
// console/server.js): an inbound X-Request-Id is honored byte-identically
// when non-empty (any non-empty value accepted as-is; missing/empty falls
// back to a generated UUIDv4); the id is echoed on EVERY response via the
// X-Request-Id header; one structured stderr line per request carries only
// {ts, id, method, path, status, ms} — never bodies, headers, or tokens;
// unexpected-500 bodies stay a fixed generic message (no id, no internals).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createConsoleServer } from '../console/server.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function boot(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-console-trace-'));
  const lines = [];
  const logStream = { write(s) { lines.push(String(s)); return true; } };
  const handler = createConsoleServer({
    ledgerPath: join(dir, 'ledger.jsonl'),
    memoryPath: join(dir, 'mem.jsonl'),
    // Hermetic: never discover cwd config (a stray file would poison results).
    configPath: join(dir, 'sentinel.config.json'),
    logStream,
    ...opts,
  });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, path, { body, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON (static shell) */ }
    return { status: res.status, headers: res.headers, json, text };
  };
  return {
    dir,
    lines,
    req,
    lastLine() { return JSON.parse(lines[lines.length - 1]); },
    async close() {
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('trace: 200 echoes a generated UUIDv4 and logs one structured line', async () => {
  const c = await boot();
  try {
    const before = c.lines.length;
    const r = await c.req('GET', '/api/healthz');
    assert.equal(r.status, 200);
    const id = r.headers.get('x-request-id');
    assert.ok(id, 'X-Request-Id must be present on 200');
    assert.match(id, UUID_V4);
    assert.equal(c.lines.length, before + 1, 'exactly one trace line per request');
    const line = c.lastLine();
    assert.deepEqual(Object.keys(line).sort(), ['id', 'method', 'ms', 'path', 'status', 'ts']);
    assert.equal(line.id, id);
    assert.equal(line.method, 'GET');
    assert.equal(line.path, '/api/healthz');
    assert.equal(line.status, 200);
    assert.ok(typeof line.ms === 'number' && line.ms >= 0);
    assert.ok(!Number.isNaN(Date.parse(line.ts)));
  } finally { await c.close(); }
});

test('trace: caller-supplied id passes through byte-identical on 200', async () => {
  const c = await boot();
  try {
    const custom = 'caller-ABC-123_~.trace';
    const r = await c.req('GET', '/api/healthz', { headers: { 'x-request-id': custom } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-request-id'), custom);
    assert.equal(c.lastLine().id, custom);
  } finally { await c.close(); }
});

test('trace: empty inbound id falls back to a generated UUID', async () => {
  const c = await boot();
  try {
    const r = await c.req('GET', '/api/healthz', { headers: { 'x-request-id': '' } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('x-request-id') ?? '', UUID_V4);
  } finally { await c.close(); }
});

test('trace: 401 echoes the caller id', async () => {
  const c = await boot({ token: 'tok' });
  try {
    const r = await c.req('GET', '/api/rules', { headers: { 'x-request-id': 'unauth-caller-1' } });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('x-request-id'), 'unauth-caller-1');
    const line = c.lastLine();
    assert.equal(line.id, 'unauth-caller-1');
    assert.equal(line.status, 401);
  } finally { await c.close(); }
});

test('trace: 404 echoes a generated id', async () => {
  const c = await boot();
  try {
    const r = await c.req('GET', '/api/nope');
    assert.equal(r.status, 404);
    const id = r.headers.get('x-request-id');
    assert.match(id ?? '', UUID_V4);
    const line = c.lastLine();
    assert.equal(line.id, id);
    assert.equal(line.path, '/api/nope');
    assert.equal(line.status, 404);
  } finally { await c.close(); }
});

test('trace: 429 echoes the caller id with a fixed body', async () => {
  const c = await boot({ rateLimit: { windowMs: 60000, max: 2 }, noExemptLoopback: true });
  try {
    assert.equal((await c.req('GET', '/api/rules')).status, 200);
    assert.equal((await c.req('GET', '/api/rules')).status, 200);
    const r = await c.req('POST', '/api/verify', {
      body: { receipt: 'x' },
      headers: { 'x-request-id': 'limited-caller-9' },
    });
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('x-request-id'), 'limited-caller-9');
    assert.deepEqual(r.json, { error: 'rate limited' });
    const line = c.lastLine();
    assert.equal(line.id, 'limited-caller-9');
    assert.equal(line.status, 429);
  } finally { await c.close(); }
});

test('trace: concurrent requests get distinct ids', async () => {
  const c = await boot();
  try {
    const rs = await Promise.all(Array.from({ length: 10 }, () => c.req('GET', '/api/healthz')));
    const ids = rs.map((r) => r.headers.get('x-request-id'));
    assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0));
    assert.equal(new Set(ids).size, ids.length, 'each concurrent request must get a distinct id');
  } finally { await c.close(); }
});

test('trace: log lines never leak bodies, headers, or tokens', async () => {
  const c = await boot({ token: 'tok-secret-value' });
  try {
    const marker = 'LEAK-MARKER-7f3a9c2e-diff-content';
    const r = await c.req('POST', '/api/review', {
      body: { diff: `diff --git a/x b/x\n+${marker}\n`, repo: 'o/r', pr: 1 },
      headers: { authorization: 'Bearer tok-secret-value', 'x-request-id': 'leak-probe-1' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-request-id'), 'leak-probe-1');
    const blob = c.lines.join('\n');
    assert.ok(!blob.includes('authorization'), 'log must not name the auth header');
    assert.ok(!blob.includes('tok-secret-value'), 'log must not contain the token');
    assert.ok(!blob.includes(marker), 'log must not contain request body content');
    assert.ok(!blob.includes('Bearer'), 'log must not contain auth scheme material');
  } finally { await c.close(); }
});

test('trace: unexpected 500 stays generic, still echoes the id', async () => {
  // ledgerPath pointed at a directory makes loadLedger throw a raw
  // non-HttpError (EISDIR) — the unexpected-500 path.
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-console-trace500-'));
  const lines = [];
  const handler = createConsoleServer({
    ledgerPath: dir,
    memoryPath: join(dir, 'mem.jsonl'),
    configPath: join(dir, 'sentinel.config.json'),
    logStream: { write(s) { lines.push(String(s)); return true; } },
  });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/repos`, {
      headers: { 'x-request-id': 'five-hundred-probe' },
    });
    const text = await res.text();
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('x-request-id'), 'five-hundred-probe');
    assert.deepEqual(JSON.parse(text), { error: 'internal error' });
    assert.ok(!text.includes('five-hundred-probe'), '500 body must not contain the request id');
    assert.ok(!text.includes('EISDIR') && !text.includes('illegal'), '500 body must not leak internals');
    const line = JSON.parse(lines[lines.length - 1]);
    assert.equal(line.id, 'five-hundred-probe');
    assert.equal(line.status, 500);
    assert.equal(line.path, '/api/repos');
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
