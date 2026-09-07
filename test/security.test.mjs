// Security regression tests (red-team wave-16 findings #1, #3, #5, #6, #8, #9, #10).
// Each test pins a verified-exploitable behavior to its fail-closed fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { ghApiArgv, globToRegExp, review } from '../lib/review.js';
import { evaluatePolicy } from '../lib/policy.js';
import { loadStore, saveStore } from '../apps/github/store.js';
import { createHandler } from '../apps/github/app.js';
import { runLocal } from '../lib/runner.js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'sentinel.js');

// #1: gh argv validation — shell metacharacters never reach exec.
test('security: ghApiArgv builds shell-free argv and rejects injection', () => {
  assert.deepEqual(ghApiArgv('o/r', 'pulls/7'), ['api', 'repos/o/r/pulls/7']);
  for (const bad of ['a/b;touch /tmp/sentinel-pwned', 'a b/c', 'a/b/c', '', 'a/']) {
    assert.throws(() => ghApiArgv(bad, 'pulls/7'), /owner\/name/);
  }
  for (const bad of ['pulls/1;id', 'pulls 1', '../x', 'a'.repeat(201)]) {
    assert.throws(() => ghApiArgv('o/r', bad), /endpoint/);
  }
});

test('security: review() with evil repo throws before any exec', async () => {
  const canary = join(tmpdir(), 'sentinel-pwned');
  try {
    await assert.rejects(
      review({ pr: 1, repo: 'a/b;touch ' + canary, diffText: undefined }),
      /owner\/name/,
    );
  } catch (err) {
    if (!/owner\/name/.test(err.message)) throw err;
  }
  assert.equal(existsSync(canary), false, 'no shell ever ran');
});

// #3: glob escaping covers every metachar, not just the first.
test('security: exclude globs escape all metacharacters', () => {
  const re = globToRegExp('*.a.b');
  assert.ok(re.test('x.a.b'), 'true positive still matches');
  assert.equal(re.test('xaxb'), false, 'second-dot wildcard must not match');
  const paren = globToRegExp('foo(bar).baz');
  assert.ok(paren.test('foo(bar).baz'));
  assert.equal(paren.test('fooXbarYbaz'), false);
});

// #9: evaluatePolicy rejects unknown severities on hand-built objects.
test('security: evaluatePolicy fails closed on unknown severity', () => {
  const evil = {
    apiVersion: 'sentinel.aftergraph/v1', kind: 'VerificationPolicy',
    metadata: { name: 'evil' },
    spec: { scope: { paths: [] }, required: [], blocking_severity: ['security', 'critical\0x'], approvals: { required: [] } },
  };
  assert.throws(() => evaluatePolicy(evil, { findings: [], checks: {} }), /unknown severity/);
});

// #5: github store fails closed on corrupt files; saves leave no tmp behind.
test('security: corrupt install store throws, saves are atomic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-secstore-'));
  try {
    const file = join(dir, 's.json');
    assert.deepEqual(loadStore(file), {}, 'missing file still yields empty store');
    writeFileSync(file, '{not json');
    assert.throws(() => loadStore(file), /corrupt store file/);
    writeFileSync(file, '[1,2]');
    assert.throws(() => loadStore(file), /corrupt store file/);
    const target = join(dir, 'w.json');
    saveStore({ a: 1 }, target);
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'no tmp siblings left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #6: redelivered webhooks do not reprocess (delivery-id dedupe).
test('security: duplicate delivery id short-circuits before api/store', async () => {
  const secret = 's3cret-test';
  let apiCalls = 0;
  const platform = new Proxy({}, { get: () => async () => { apiCalls++; return {}; } });
  const handler = createHandler({ platform, secret, opts: {} });
  const send = (headers, body) => new Promise((resolve) => {
    const req = { method: 'POST', url: '/webhooks/github', headers, socket: { remoteAddress: '1.2.3.4' }, on: (ev, fn) => { if (ev === 'data') fn(Buffer.from(body)); if (ev === 'end') fn(); } };
    const res = { statusCode: 200, setHeader() {}, writeHead(code) { this.statusCode = code; }, end(payload) { resolve({ status: this.statusCode, body: String(payload) }); } };
    handler(req, res).catch((e) => resolve({ status: 500, body: String(e && e.message) }));
  });
  const body = JSON.stringify({ action: 'opened', repository: { full_name: 'o/r' }, pull_request: { number: 1 } });
  const sig = 'sha256=' + createHmac('sha256', secret).update(Buffer.from(body)).digest('hex');
  const headers = { 'x-github-event': 'ping', 'x-hub-signature-256': sig, 'x-github-delivery': 'deliv-1' };
  const first = await send(headers, body);
  assert.equal(first.status, 200);
  const before = apiCalls;
  const second = await send(headers, body);
  assert.equal(second.status, 200);
  assert.ok(JSON.parse(second.body).deduped, 'replay flagged duplicate');
  assert.equal(apiCalls, before, 'no platform calls on replay');
});

// #8: runner caps output incrementally and kills process groups on timeout.
test('security: runner truncates flood output and honors timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-secflood-'));
  try {
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
    writeFileSync(join(dir, 'f.txt'), 'x\n');
    execFileSync('git', ['-C', dir, 'add', '.']);
    execFileSync('git', ['-C', dir, 'commit', '-qm', 'init']);
    const sha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const flood = await runLocal({
      repoDir: dir, targetSha: sha, timeoutMs: 30000, env: {},
      checks: [{ type: 'BUILD', command: ['node', '-e', 'process.stdout.write("y".repeat(300000))'] }],
    });
    assert.ok(flood.checks[0].stdout.length <= 65536, `capped at 64KB, got ${flood.checks[0].stdout.length}`);
    const t0 = Date.now();
    const slow = await runLocal({
      repoDir: dir, targetSha: sha, timeoutMs: 1500, env: {},
      checks: [{ type: 'TEST', command: ['node', '-e', 'setTimeout(() => {}, 60000)'] }],
    });
    const dt = Date.now() - t0;
    assert.equal(slow.checks[0].status, 'TIMEOUT');
    assert.ok(dt < 30000, `timeout fired promptly in ${dt}ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #10: strict flag parsing fails closed on typos.
test('security: unknown CLI flags exit non-zero with a clean error', () => {
  const r = spawnSync('node', [BIN, 'review', '--diff', '/tmp/x.diff', '--typo-flag'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'typo flag must fail');
  assert.match(r.stderr, /Unknown option '--typo-flag'/);
  assert.ok(!/^\s*at /m.test(r.stderr), 'no stack trace to users');
});
