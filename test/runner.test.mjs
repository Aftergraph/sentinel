import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clear, list } from '../lib/audit.js';
import { runLocal, MAX_OUTPUT_BYTES } from '../lib/runner.js';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-src-'));
  git(['init'], dir);
  git(['config', 'user.email', 't@t.t'], dir);
  git(['config', 'user.name', 't'], dir);
  writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'init'], dir);
  const sha = git(['rev-parse', 'HEAD'], dir);
  return { dir, sha, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}

function baseEnv(extra = {}) {
  // Explicit allowlist: caller passes PATH through; runner must not inherit.
  return { PATH: process.env.PATH, ...extra };
}

function nodeEval(js) {
  return ['node', '-e', js];
}

test('runner: success seals one evidence item per check, isolates cwd, cleans temp, audits', async () => {
  clear();
  const repo = makeRepo();
  try {
    const before = list().length;
    const res = await runLocal({
      repoDir: repo.dir,
      targetSha: repo.sha,
      checks: [
        { type: 'BUILD', command: nodeEval("console.log(process.cwd())") },
        { type: 'TEST', command: nodeEval("require('fs').writeFileSync('isolated-marker.txt','hi')") },
      ],
      timeoutMs: 10000,
      env: baseEnv(),
    });
    assert.equal(res.targetSha, repo.sha);
    assert.equal(res.checks.length, 2);
    assert.equal(res.evidenceItems.length, 2);
    assert.deepEqual(res.checks.map((c) => c.status), ['PASS', 'PASS']);
    assert.equal(res.status, 'PASS');
    // Never runs in place: cwd is the temp copy, marker absent from source.
    assert.notEqual(res.checks[0].stdout.trim(), repo.dir);
    assert.equal(res.checks[0].stdout.trim(), res.workDir);
    assert.equal(existsSync(path.join(repo.dir, 'isolated-marker.txt')), false);
    // Per-check fields bounded and recorded.
    for (const c of res.checks) {
      assert.ok(typeof c.durationMs === 'number' && c.durationMs >= 0);
      assert.equal(typeof c.exitCode, 'number');
      assert.ok(c.stdout.length <= MAX_OUTPUT_BYTES && c.stderr.length <= MAX_OUTPUT_BYTES);
    }
    // Evidence sealed via lib/evidence.js.
    for (let i = 0; i < res.evidenceItems.length; i++) {
      const ev = res.evidenceItems[i];
      assert.ok(Object.isFrozen(ev));
      assert.equal(ev.targetSha, repo.sha);
      assert.equal(ev.type, res.checks[i].type);
      assert.match(ev.id, /^[0-9a-f]{64}$/);
      assert.equal(ev.id, ev.outputHash);
    }
    // Temp dir removed.
    assert.equal(existsSync(res.workDir), false);
    assert.equal(existsSync(res.tmpBase), false);
    // Audit trail.
    const types = list().slice(before).map((e) => e.type);
    assert.ok(types.includes('runner_start'));
    assert.ok(types.includes('runner_check'));
    assert.ok(types.includes('runner_complete'));
    const seqs = list().map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1]);
  } finally {
    repo.cleanup();
  }
});

test('runner: SHA mismatch throws INVALID_VERIFICATION and runs nothing', async () => {
  clear();
  const repo = makeRepo();
  const marker = path.join(os.tmpdir(), `sentinel-norun-${process.pid}-${Date.now()}.txt`);
  if (existsSync(marker)) rmSync(marker);
  let err = null;
  try {
    await runLocal({
      repoDir: repo.dir,
      targetSha: '0'.repeat(40),
      checks: [{ type: 'TEST', command: nodeEval(`require('fs').writeFileSync(${JSON.stringify(marker)},'hi')`) }],
      timeoutMs: 10000,
      env: baseEnv(),
    });
  } catch (e) { err = e; }
  try {
    assert.ok(err, 'expected INVALID_VERIFICATION throw');
    assert.match(err.message, /INVALID_VERIFICATION/);
    assert.equal(err.code, 'INVALID_VERIFICATION');
    assert.equal(existsSync(marker), false, 'check command must not have executed');
    assert.ok(err.workDir, 'error should carry workDir for cleanup assertion');
    assert.equal(existsSync(err.workDir), false, 'temp dir must be removed on SHA mismatch');
    if (err.tmpBase) assert.equal(existsSync(err.tmpBase), false);
  } finally {
    if (existsSync(marker)) rmSync(marker);
    repo.cleanup();
  }
});

test('runner: timeout kills the child, marks TIMEOUT, and cleans up', async () => {
  clear();
  const repo = makeRepo();
  try {
    const res = await runLocal({
      repoDir: repo.dir,
      targetSha: repo.sha,
      checks: [{ type: 'TEST', command: nodeEval('setTimeout(()=>{},5000)') }],
      timeoutMs: 400,
      env: baseEnv(),
    });
    assert.equal(res.checks.length, 1);
    assert.equal(res.checks[0].status, 'TIMEOUT');
    assert.equal(res.checks[0].exitCode, null);
    assert.ok(res.checks[0].durationMs < 5000, `should have killed early, took ${res.checks[0].durationMs}ms`);
    assert.equal(res.status, 'FAIL');
    assert.equal(res.evidenceItems.length, 1);
    assert.equal(res.evidenceItems[0].result, 'timeout');
    assert.equal(existsSync(res.workDir), false);
    assert.equal(existsSync(res.tmpBase), false);
  } finally {
    repo.cleanup();
  }
});

test('runner: stdout/stderr truncated to 64KB', async () => {
  clear();
  const repo = makeRepo();
  try {
    const res = await runLocal({
      repoDir: repo.dir,
      targetSha: repo.sha,
      checks: [{ type: 'TEST', command: nodeEval("process.stdout.write('A'.repeat(200000));process.stderr.write('B'.repeat(200000))") }],
      timeoutMs: 10000,
      env: baseEnv(),
    });
    assert.equal(res.checks[0].status, 'PASS');
    assert.equal(res.checks[0].stdout.length, MAX_OUTPUT_BYTES);
    assert.equal(res.checks[0].stderr.length, MAX_OUTPUT_BYTES);
    assert.equal(MAX_OUTPUT_BYTES, 64 * 1024);
    assert.equal(existsSync(res.workDir), false);
  } finally {
    repo.cleanup();
  }
});

test('runner: secret values scrubbed to [REDACTED]', async () => {
  clear();
  const repo = makeRepo();
  try {
    const secret = 's3cr3t-value-xyz-123';
    const res = await runLocal({
      repoDir: repo.dir,
      targetSha: repo.sha,
      checks: [{ type: 'SECRET_SCAN', command: nodeEval("console.log('leak:'+process.env.MY_SECRET)") }],
      timeoutMs: 10000,
      env: baseEnv({ MY_SECRET: secret }),
      secretKeys: ['MY_SECRET'],
    });
    assert.ok(res.checks[0].stdout.includes('[REDACTED]'));
    assert.ok(!res.checks[0].stdout.includes(secret), 'raw secret must not appear in captured output');
    assert.equal(existsSync(res.workDir), false);
  } finally {
    repo.cleanup();
  }
});

test('runner: env allowlist only (no process.env inheritance)', async () => {
  clear();
  const repo = makeRepo();
  const key = 'SENTINEL_ALLOWLIST_PROBE';
  process.env[key] = 'should-not-leak';
  try {
    const res = await runLocal({
      repoDir: repo.dir,
      targetSha: repo.sha,
      checks: [
        { type: 'TEST', command: nodeEval(`console.log(process.env.${key}||'absent')`) },
        { type: 'BUILD', command: nodeEval("console.log(process.env.EXPLICIT_ONE||'missing')") },
      ],
      timeoutMs: 10000,
      env: baseEnv({ EXPLICIT_ONE: 'yes-explicit' }),
    });
    assert.match(res.checks[0].stdout, /absent/, 'inherited process.env must not leak into child');
    assert.match(res.checks[1].stdout, /yes-explicit/, 'explicit env must be visible');
    assert.equal(existsSync(res.workDir), false);
  } finally {
    delete process.env[key];
    repo.cleanup();
  }
});

test('runner: checks run sequentially in input order', async () => {
  clear();
  const repo = makeRepo();
  try {
    const res = await runLocal({
      repoDir: repo.dir,
      targetSha: repo.sha,
      checks: [
        { type: 'BUILD', command: nodeEval("console.log('first')") },
        { type: 'TEST', command: nodeEval("console.log('second')") },
        { type: 'LINT', command: nodeEval("console.log('third')") },
      ],
      timeoutMs: 10000,
      env: baseEnv(),
    });
    assert.deepEqual(res.checks.map((c) => c.type), ['BUILD', 'TEST', 'LINT']);
    assert.deepEqual(res.checks.map((c) => c.stdout.trim()), ['first', 'second', 'third']);
    assert.equal(existsSync(res.workDir), false);
  } finally {
    repo.cleanup();
  }
});

test('runner: failing check seals evidence, overall FAIL, temp still removed', async () => {
  clear();
  const repo = makeRepo();
  try {
    const res = await runLocal({
      repoDir: repo.dir,
      targetSha: repo.sha,
      checks: [{ type: 'TEST', command: nodeEval('process.exit(3)') }],
      timeoutMs: 10000,
      env: baseEnv(),
    });
    assert.equal(res.checks[0].status, 'FAIL');
    assert.equal(res.checks[0].exitCode, 3);
    assert.equal(res.status, 'FAIL');
    assert.equal(res.evidenceItems.length, 1);
    assert.equal(res.evidenceItems[0].exitCode, 3);
    assert.ok(Object.isFrozen(res.evidenceItems[0]));
    assert.equal(existsSync(res.workDir), false);
  } finally {
    repo.cleanup();
  }
});

test('runner: resource policy default 120s, max 600s throws', async () => {
  clear();
  const repo = makeRepo();
  try {
    // Default timeoutMs (omitted) still runs.
    const res = await runLocal({
      repoDir: repo.dir,
      targetSha: repo.sha,
      checks: [{ type: 'TEST', command: nodeEval("console.log('ok')") }],
      env: baseEnv(),
    });
    assert.equal(res.checks[0].status, 'PASS');
    assert.equal(existsSync(res.workDir), false);
    // Over-max throws before running anything.
    await assert.rejects(
      () => runLocal({ repoDir: repo.dir, targetSha: repo.sha, checks: [{ type: 'TEST', command: ['node', '-e', '1'] }], timeoutMs: 600001, env: baseEnv() }),
      /600000|timeout/i,
    );
    await assert.rejects(
      () => runLocal({ repoDir: repo.dir, targetSha: repo.sha, checks: [{ type: 'TEST', command: ['node', '-e', '1'] }], timeoutMs: 0, env: baseEnv() }),
      /timeoutMs/i,
    );
  } finally {
    repo.cleanup();
  }
});
