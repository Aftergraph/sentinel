import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clear, list } from '../lib/audit.js';
import { createFinding } from '../lib/finding.js';
import { planChecks } from '../lib/verify.js';
import { executePipeline } from '../lib/pipeline.js';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-pipe-src-'));
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
  return { PATH: process.env.PATH, ...extra };
}

function nodeEval(js) {
  return [process.execPath, '-e', js];
}

function mkFinding(sha, over = {}) {
  return createFinding({
    ruleId: 'no-eval-with-dynamic-input',
    file: 'a.js',
    line: 1,
    evidence: 'eval(x)',
    targetSha: sha,
    ...over,
  });
}

function markerPath(tag) {
  return path.join(os.tmpdir(), `sentinel-pipe-norun-${process.pid}-${tag}.txt`);
}

function noRunnerEvents() {
  return !list().some((e) => e.type.startsWith('runner_'));
}

test('pipeline: happy path PASS → CONFIRMED with sealed evidence attached', async () => {
  clear();
  const repo = makeRepo();
  try {
    const finding = mkFinding(repo.sha);
    const commands = {
      BUILD: { command: nodeEval('process.exit(0)') },
      TEST: { command: nodeEval('process.exit(0)') },
    };
    const out = await executePipeline({
      finding,
      repoDir: repo.dir,
      targetSha: repo.sha,
      commands,
      env: baseEnv(),
      policy: { checks: ['BUILD', 'TEST'] },
    });
    assert.equal(out.run.status, 'PASS');
    assert.equal(out.run.findingId, finding.id);
    assert.equal(finding.verification_state, 'CONFIRMED');
    assert.equal(out.finding, finding);
    assert.equal(out.evidence.length, 2);
    for (const ev of out.evidence) {
      assert.ok(Object.isFrozen(ev));
      assert.match(ev.id, /^[0-9a-f]{64}$/);
      assert.equal(ev.id, ev.outputHash);
      assert.equal(ev.targetSha, repo.sha);
    }
    assert.deepEqual(finding.evidenceRefs, out.evidence.map((e) => e.id));
    assert.ok(Array.isArray(out.auditTrail) && out.auditTrail.length > 0);
  } finally {
    repo.cleanup();
  }
});

test('pipeline: default plan (no policy) PASS → CONFIRMED', async () => {
  clear();
  const repo = makeRepo();
  try {
    const finding = mkFinding(repo.sha);
    const plan = planChecks(finding);
    assert.ok(plan.length > 0);
    const commands = Object.fromEntries(plan.map((t) => [t, { command: nodeEval('process.exit(0)') }]));
    const out = await executePipeline({
      finding,
      repoDir: repo.dir,
      targetSha: repo.sha,
      commands,
      env: baseEnv(),
    });
    assert.equal(out.run.status, 'PASS');
    assert.equal(finding.verification_state, 'CONFIRMED');
    assert.equal(out.evidence.length, plan.length);
  } finally {
    repo.cleanup();
  }
});

test('pipeline: refute exit code → NOT_REPRODUCED, run FAIL', async () => {
  clear();
  const repo = makeRepo();
  try {
    const finding = mkFinding(repo.sha);
    const out = await executePipeline({
      finding,
      repoDir: repo.dir,
      targetSha: repo.sha,
      commands: {
        BUILD: { command: nodeEval('process.exit(0)') },
        TEST: { command: nodeEval('process.exit(99)'), refuteExitCode: 99 },
      },
      env: baseEnv(),
      policy: { checks: ['BUILD', 'TEST'] },
    });
    assert.equal(out.run.status, 'FAIL');
    assert.equal(out.run.outcome, 'NOT_REPRODUCED');
    assert.equal(finding.verification_state, 'NOT_REPRODUCED');
    assert.equal(out.evidence.length, 2);
  } finally {
    repo.cleanup();
  }
});

test('pipeline: timeout → run FAIL, finding stays VERIFYING (never silent CONFIRMED)', async () => {
  clear();
  const repo = makeRepo();
  try {
    const finding = mkFinding(repo.sha);
    const out = await executePipeline({
      finding,
      repoDir: repo.dir,
      targetSha: repo.sha,
      commands: { TEST: { command: nodeEval('setTimeout(()=>{},5000)') } },
      env: baseEnv(),
      policy: { checks: ['TEST'], timeoutMs: 300 },
    });
    assert.equal(out.run.status, 'FAIL');
    assert.notEqual(out.run.status, 'PASS');
    assert.equal(finding.verification_state, 'VERIFYING');
    assert.notEqual(finding.verification_state, 'CONFIRMED');
    // Full results map was supplied (no spurious BLOCKED); timeout evidence sealed + attached.
    assert.equal(out.evidence.length, 1);
    assert.equal(out.evidence[0].result, 'timeout');
    assert.deepEqual(finding.evidenceRefs, [out.evidence[0].id]);
    const done = out.auditTrail.find((e) => e.type === 'verify_complete');
    assert.ok(done);
    assert.equal(done.to, 'FAIL');
    assert.equal(done.reason, 'VERIFYING');
  } finally {
    repo.cleanup();
  }
});

test('pipeline: SHA mismatch propagates INVALID_VERIFICATION, finding untouched', async () => {
  clear();
  const repo = makeRepo();
  const marker = markerPath(`mismatch-${Date.now()}`);
  try {
    const wrong = 'f'.repeat(40);
    const finding = mkFinding(wrong);
    const before = JSON.parse(JSON.stringify(finding));
    let err = null;
    try {
      await executePipeline({
        finding,
        repoDir: repo.dir,
        targetSha: wrong,
        commands: {
          TEST: { command: nodeEval(`require('fs').writeFileSync(${JSON.stringify(marker)},'hi')`) },
        },
        env: baseEnv(),
        policy: { checks: ['TEST'] },
      });
    } catch (e) { err = e; }
    assert.ok(err, 'expected INVALID_VERIFICATION throw');
    assert.match(err.message, /INVALID_VERIFICATION/);
    assert.equal(err.code, 'INVALID_VERIFICATION');
    assert.equal(finding.verification_state, 'HYPOTHESIS');
    assert.equal(finding.evidenceRefs, undefined);
    assert.deepEqual(finding, before);
    assert.equal(existsSync(marker), false, 'check command must not have executed');
  } finally {
    if (existsSync(marker)) rmSync(marker);
    repo.cleanup();
  }
});

test('pipeline: zero-check plan throws, executes nothing', async () => {
  clear();
  const repo = makeRepo();
  const marker = markerPath(`zero-${Date.now()}`);
  try {
    const finding = mkFinding(repo.sha);
    await assert.rejects(
      () => executePipeline({
        finding,
        repoDir: repo.dir,
        targetSha: repo.sha,
        commands: {
          BUILD: { command: nodeEval(`require('fs').writeFileSync(${JSON.stringify(marker)},'hi')`) },
        },
        env: baseEnv(),
        policy: { checks: [] },
      }),
      /non-empty/,
    );
    assert.equal(finding.verification_state, 'HYPOTHESIS');
    assert.equal(finding.evidenceRefs, undefined);
    assert.equal(existsSync(marker), false, 'no command may execute on an empty plan');
    assert.ok(noRunnerEvents());
  } finally {
    if (existsSync(marker)) rmSync(marker);
    repo.cleanup();
  }
});

test('pipeline: unknown check type in policy throws before any exec', async () => {
  clear();
  const repo = makeRepo();
  const marker = markerPath(`unknown-${Date.now()}`);
  try {
    const finding = mkFinding(repo.sha);
    await assert.rejects(
      () => executePipeline({
        finding,
        repoDir: repo.dir,
        targetSha: repo.sha,
        commands: {
          BUILD: { command: nodeEval(`require('fs').writeFileSync(${JSON.stringify(marker)},'hi')`) },
        },
        env: baseEnv(),
        policy: { checks: ['BUILD', 'LLM_JUDGE'] },
      }),
      /unknown check type/,
    );
    assert.equal(finding.verification_state, 'HYPOTHESIS');
    assert.equal(existsSync(marker), false, 'no command may execute after an unknown check type');
    assert.ok(noRunnerEvents());
  } finally {
    if (existsSync(marker)) rmSync(marker);
    repo.cleanup();
  }
});

test('pipeline: required check with no configured command throws before any exec', async () => {
  clear();
  const repo = makeRepo();
  const marker = markerPath(`missing-${Date.now()}`);
  try {
    const finding = mkFinding(repo.sha);
    await assert.rejects(
      () => executePipeline({
        finding,
        repoDir: repo.dir,
        targetSha: repo.sha,
        commands: {
          BUILD: { command: nodeEval(`require('fs').writeFileSync(${JSON.stringify(marker)},'hi')`) },
        },
        env: baseEnv(),
        policy: { checks: ['BUILD', 'TEST'] },
      }),
      /no command configured.*TEST/,
    );
    assert.equal(finding.verification_state, 'HYPOTHESIS');
    assert.equal(existsSync(marker), false, 'configured commands must not run when a sibling check is unmapped');
    assert.ok(noRunnerEvents());
  } finally {
    if (existsSync(marker)) rmSync(marker);
    repo.cleanup();
  }
});

test('pipeline: audit trail ordered across plan/run/complete', async () => {
  clear();
  const repo = makeRepo();
  try {
    const finding = mkFinding(repo.sha);
    const out = await executePipeline({
      finding,
      repoDir: repo.dir,
      targetSha: repo.sha,
      commands: {
        BUILD: { command: nodeEval('process.exit(0)') },
        TEST: { command: nodeEval('process.exit(0)') },
      },
      env: baseEnv(),
      policy: { checks: ['BUILD', 'TEST'] },
    });
    const trail = out.auditTrail;
    const seqs = trail.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], 'audit seq must be strictly increasing');
    const types = trail.map((e) => e.type);
    const order = ['verify_plan', 'verify_start', 'runner_start', 'runner_check', 'runner_complete', 'verify_complete'];
    let cursor = -1;
    for (const t of order) {
      const idx = types.indexOf(t, cursor + 1);
      assert.ok(idx > cursor, `expected ${t} after position ${cursor}`);
      cursor = idx;
    }
    for (const t of ['transition', 'evidence']) {
      assert.ok(types.includes(t), `missing audit event ${t}`);
    }
    const done = trail.find((e) => e.type === 'verify_complete');
    assert.equal(done.findingId, finding.id);
    assert.equal(done.to, 'PASS');
    assert.equal(done.reason, 'CONFIRMED');
  } finally {
    repo.cleanup();
  }
});
