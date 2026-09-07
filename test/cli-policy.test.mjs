import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePolicy } from '../lib/policy.js';
import { planChecks } from '../lib/verify.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'bin', 'sentinel.js');
const NEG_DIFF = path.join(ROOT, 'test', 'fixtures', 'no-eval-with-dynamic-input', 'negative.diff');
const POS_DIFF = path.join(ROOT, 'test', 'fixtures', 'no-eval-with-dynamic-input', 'positive.diff');

const OPEN_YAML = `apiVersion: sentinel.aftergraph/v1
kind: VerificationPolicy
metadata:
  name: cli-open
spec:
  scope:
    repo: acme/web
    paths: []
  required: []
  blocking_severity:
    - security
  approvals:
    required: []
`;

const GATED_YAML = `apiVersion: sentinel.aftergraph/v1
kind: VerificationPolicy
metadata:
  name: cli-gated
spec:
  scope:
    repo: acme/web
    paths: []
  required:
    - sast
  blocking_severity:
    - security
  approvals:
    required: []
`;

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function scratch(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writePolicy(dir, name, yaml) {
  const p = path.join(dir, name);
  writeFileSync(p, yaml);
  return p;
}

function memPath(dir) {
  const p = path.join(dir, 'mem.jsonl');
  writeFileSync(p, '');
  return p;
}

function reviewArgs({ diff, policy, format, mem }) {
  const args = [
    'review', '--diff', diff, '--repo', 'acme/web', '--head-sha', 'deadbeef',
    '--no-ledger', '--memory-path', mem,
  ];
  if (policy) args.push('--policy', policy);
  if (format) args.push('--format', format);
  return args;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeRepo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-cli-repo-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 't@t.t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  return { dir, sha: git(dir, ['rev-parse', 'HEAD']) };
}

const HEX64 = /^[0-9a-f]{64}$/;

// --- review --policy ---

test('cli policy: SHIP stays SHIP with pinned version (human)', (t) => {
  const dir = scratch(t);
  const policyPath = writePolicy(dir, 'open.yaml', OPEN_YAML);
  const policy = parsePolicy(OPEN_YAML);
  const hash8 = policy.policyVersion.split('@')[1].slice(0, 8);
  const r = runCli(reviewArgs({ diff: NEG_DIFF, policy: policyPath, mem: memPath(dir) }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SHIP — 0 findings/);
  assert.ok(r.stdout.includes(`policy: cli-open@${hash8} SHIP`), r.stdout);
  assert.ok(!r.stdout.includes('\x1b['), 'no ANSI escape codes when piped');
});

test('cli policy: SHIP pinned version in json policyEvaluation', (t) => {
  const dir = scratch(t);
  const policyPath = writePolicy(dir, 'open.yaml', OPEN_YAML);
  const policy = parsePolicy(OPEN_YAML);
  const r = runCli(reviewArgs({ diff: NEG_DIFF, policy: policyPath, format: 'json', mem: memPath(dir) }));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict.decision, 'SHIP');
  assert.equal(out.policyEvaluation.verdict, 'SHIP');
  assert.equal(out.policyEvaluation.policyVersion, policy.policyVersion);
  assert.ok(Array.isArray(out.policyEvaluation.reasons) && out.policyEvaluation.reasons.length > 0);
});

test('cli policy: BLOCKED override visible in human output', (t) => {
  const dir = scratch(t);
  const policyPath = writePolicy(dir, 'gated.yaml', GATED_YAML);
  const policy = parsePolicy(GATED_YAML);
  const hash8 = policy.policyVersion.split('@')[1].slice(0, 8);
  const r = runCli(reviewArgs({ diff: NEG_DIFF, policy: policyPath, mem: memPath(dir) }));
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stdout.includes(`policy: cli-gated@${hash8} BLOCKED`), r.stdout);
  assert.ok(!r.stdout.includes('\x1b['), 'no ANSI escape codes when piped');
});

test('cli policy: BLOCKED override visible in json policyEvaluation', (t) => {
  const dir = scratch(t);
  const policyPath = writePolicy(dir, 'gated.yaml', GATED_YAML);
  const policy = parsePolicy(GATED_YAML);
  const r = runCli(reviewArgs({ diff: NEG_DIFF, policy: policyPath, format: 'json', mem: memPath(dir) }));
  assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict.decision, 'BLOCKED');
  assert.equal(out.policyEvaluation.verdict, 'BLOCKED');
  assert.equal(out.policyEvaluation.policyVersion, policy.policyVersion);
  assert.ok(out.policyEvaluation.reasons.some((reason) => reason.includes('sast')), JSON.stringify(out.policyEvaluation.reasons));
});

test('cli policy: rule DO_NOT_SHIP stands over policy SHIP (no de-escalation)', (t) => {
  const dir = scratch(t);
  const lenientYaml = OPEN_YAML
    .replace('name: cli-open', 'name: cli-lenient')
    .replace('  blocking_severity:\n    - security\n', '  blocking_severity: []\n');
  const policyPath = writePolicy(dir, 'lenient.yaml', lenientYaml);
  const policy = parsePolicy(lenientYaml);
  const hash8 = policy.policyVersion.split('@')[1].slice(0, 8);
  const r = runCli(reviewArgs({ diff: POS_DIFF, policy: policyPath, mem: memPath(dir) }));
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /DO NOT SHIP/);
  assert.ok(r.stdout.includes(`policy: cli-lenient@${hash8} SHIP`), r.stdout);
});

test('cli policy: missing policy file fails closed with exit 2, no verdict', (t) => {
  const dir = scratch(t);
  const r = runCli(reviewArgs({ diff: NEG_DIFF, policy: path.join(dir, 'nope.yaml'), mem: memPath(dir) }));
  assert.equal(r.status, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /cannot read policy file/);
  assert.ok(!r.stdout.includes('SHIP'), 'no verdict on stdout');
  assert.ok(!r.stdout.includes('DO_NOT_SHIP'), 'no verdict on stdout');
  assert.ok(!r.stdout.includes('policy:'), 'no policy line on stdout');
});

test('cli policy: unparseable policy file fails closed with exit 2, no verdict', (t) => {
  const dir = scratch(t);
  const policyPath = writePolicy(dir, 'bad.yaml', 'not: [valid yaml\n  - broken\n');
  const r = runCli(reviewArgs({ diff: NEG_DIFF, policy: policyPath, mem: memPath(dir) }));
  assert.equal(r.status, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /invalid policy/i);
  assert.ok(!r.stdout.includes('SHIP'), 'no verdict on stdout');
  assert.ok(!r.stdout.includes('policy:'), 'no policy line on stdout');
});

// --- verify run ---

const FINDING_SPEC = 'no-eval-with-dynamic-input:src/app.js:3';
const FINDING_SHAPE = { ruleId: 'no-eval-with-dynamic-input', file: 'src/app.js', line: 3 };

function passCommands(plan) {
  return Object.fromEntries(
    plan.map((type) => [type, { command: [process.execPath, '-e', 'process.exit(0)'] }]),
  );
}

test('cli verify run: happy path on a fixture git repo (human)', (t) => {
  const dir = scratch(t);
  const repo = makeRepo();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  const plan = planChecks(FINDING_SHAPE);
  assert.ok(plan.length > 0);
  const commandsPath = path.join(dir, 'commands.json');
  writeFileSync(commandsPath, JSON.stringify(passCommands(plan)));
  const r = runCli(['verify', 'run', '--finding', FINDING_SPEC, '--repo-dir', repo.dir, '--commands', commandsPath]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^run: [0-9a-f-]{36}$/m);
  for (const type of plan) {
    assert.ok(r.stdout.includes(`check ${type}: PASS`), `missing PASS line for ${type}:\n${r.stdout}`);
  }
  assert.match(r.stdout, /HYPOTHESIS -> CONFIRMED/);
  const evidenceIds = r.stdout.split('\n').filter((l) => l.startsWith('evidence: ')).map((l) => l.slice('evidence: '.length));
  assert.equal(evidenceIds.length, plan.length);
  for (const id of evidenceIds) assert.match(id, HEX64);
  assert.ok(!r.stdout.includes('\x1b['), 'no ANSI escape codes when piped');
});

test('cli verify run: same result machine-readably with --format json', (t) => {
  const dir = scratch(t);
  const repo = makeRepo();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  const plan = planChecks(FINDING_SHAPE);
  const commandsPath = path.join(dir, 'commands.json');
  writeFileSync(commandsPath, JSON.stringify(passCommands(plan)));
  const r = runCli(['verify', 'run', '--finding', FINDING_SPEC, '--repo-dir', repo.dir, '--commands', commandsPath, '--format', 'json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.run.id, /^[0-9a-f-]{36}$/);
  assert.equal(out.run.status, 'PASS');
  assert.equal(out.run.checks.length, plan.length);
  for (const check of out.run.checks) {
    assert.ok(plan.includes(check.type), `unexpected check ${check.type}`);
    assert.equal(check.status, 'PASS');
    assert.equal(check.exitCode, 0);
    assert.match(check.evidenceId, HEX64);
  }
  assert.equal(out.finding.ruleId, FINDING_SHAPE.ruleId);
  assert.equal(out.finding.file, FINDING_SHAPE.file);
  assert.equal(out.finding.line, FINDING_SHAPE.line);
  assert.equal(out.finding.from, 'HYPOTHESIS');
  assert.equal(out.finding.to, 'CONFIRMED');
  assert.equal(out.evidence.length, plan.length);
  for (const id of out.evidence) assert.match(id, HEX64);
});

test('cli verify run: unknown check type fails closed with exit 2 pre-exec', (t) => {
  const dir = scratch(t);
  const repo = makeRepo();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'must-not-exist.txt');
  const commandsPath = path.join(dir, 'commands.json');
  writeFileSync(commandsPath, JSON.stringify({
    BOGUS_CHECK: { command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'hi')`] },
  }));
  const r = runCli(['verify', 'run', '--finding', FINDING_SPEC, '--repo-dir', repo.dir, '--commands', commandsPath]);
  assert.equal(r.status, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /unknown check type/);
  assert.equal(existsSync(marker), false, 'no command may execute after an unknown check type');
  assert.ok(!r.stdout.includes('run: '), 'no run output pre-exec');
});

test('cli verify run: missing command for a required check fails closed with exit 2 pre-exec', (t) => {
  const dir = scratch(t);
  const repo = makeRepo();
  t.after(() => rmSync(repo.dir, { recursive: true, force: true }));
  const plan = planChecks(FINDING_SHAPE);
  assert.ok(plan.length > 1);
  const marker = path.join(dir, 'must-not-exist.txt');
  const commandsPath = path.join(dir, 'commands.json');
  writeFileSync(commandsPath, JSON.stringify({
    [plan[0]]: { command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'hi')`] },
  }));
  const r = runCli(['verify', 'run', '--finding', FINDING_SPEC, '--repo-dir', repo.dir, '--commands', commandsPath]);
  assert.equal(r.status, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /no command configured/);
  assert.equal(existsSync(marker), false, 'configured commands must not run when a sibling check is unmapped');
});

// --- additive-only guard ---

test('cli: no-flag review output carries no policy surface', (t) => {
  const dir = scratch(t);
  const r = runCli(reviewArgs({ diff: NEG_DIFF, mem: memPath(dir) }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SHIP — 0 findings/);
  assert.ok(!r.stdout.includes('policy:'), 'policy line must be absent without --policy');
  assert.ok(!r.stdout.includes('\x1b['), 'no ANSI escape codes when piped');
});
