import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeVerdict, formatHuman, toJson } from '../lib/review.js';
import { parsePolicy } from '../lib/policy.js';
import { list as listAudit, clear as clearAudit } from '../lib/audit.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'bin', 'sentinel.js');
const NEG_DIFF = path.join(ROOT, 'test', 'fixtures', 'no-eval-with-dynamic-input', 'negative.diff');
const POS_DIFF = path.join(ROOT, 'test', 'fixtures', 'no-eval-with-dynamic-input', 'positive.diff');

const META = { headSha: 'h', baseSha: 'b', rulePackVersion: '1.0.0' };

const SEC_FINDING = {
  ruleId: 'no-eval-with-dynamic-input',
  file: 'src/app.js',
  line: 2,
  evidence: 'eval(x)',
};

// Gated policy: requires a 'sast' check result -> BLOCKED while missing.
const GATED_YAML = `apiVersion: sentinel.aftergraph/v1
kind: VerificationPolicy
metadata:
  name: override-gated
spec:
  scope:
    repo: acme/web
    paths:
      - "src/**"
  required:
    - sast
  blocking_severity:
    - security
  approvals:
    required: []
`;

const EM_DASH = ' — ';

function lastAuditEvent() {
  const events = listAudit();
  return events[events.length - 1];
}

// --- computeVerdict override ---

test('override SHIP -> DO_NOT_SHIP with audit event', () => {
  clearAudit();
  const result = computeVerdict([], new Set(), {
    ...META,
    override: { verdict: 'DO_NOT_SHIP', actor: 'alice', reason: 'incident-123' },
  });
  assert.equal(result.verdict, 'DO_NOT_SHIP');
  assert.equal(result.overriddenFrom, 'SHIP');
  assert.deepEqual(result.overridden, {
    actor: 'alice',
    reason: 'incident-123',
    from: 'SHIP',
    to: 'DO_NOT_SHIP',
  });
  // Blocking/non-blocking evidence is preserved, not rewritten.
  assert.deepEqual(result.blocking, []);
  const event = lastAuditEvent();
  assert.equal(event.type, 'verdict.overridden');
  assert.equal(event.actor, 'alice');
  assert.equal(event.reason, 'incident-123');
  assert.equal(event.from, 'SHIP');
  assert.equal(event.to, 'DO_NOT_SHIP');
  assert.equal(event.headSha, 'h');
});

test('override DO_NOT_SHIP -> SHIP with audit event', () => {
  clearAudit();
  const result = computeVerdict([SEC_FINDING], new Set(), {
    ...META,
    override: { verdict: 'SHIP', actor: 'bob', reason: 'false positive, verified by hand' },
  });
  assert.equal(result.verdict, 'SHIP');
  assert.equal(result.overriddenFrom, 'DO_NOT_SHIP');
  assert.deepEqual(result.blocking, [SEC_FINDING]);
  const event = lastAuditEvent();
  assert.equal(event.type, 'verdict.overridden');
  assert.equal(event.actor, 'bob');
  assert.equal(event.from, 'DO_NOT_SHIP');
  assert.equal(event.to, 'SHIP');
  assert.equal(event.headSha, 'h');
});

test('override over a policy-escalated verdict keeps policy evaluation', () => {
  clearAudit();
  const policy = parsePolicy(GATED_YAML);
  const result = computeVerdict([], new Set(), {
    ...META,
    policy: { policies: [policy], repo: 'acme/web', path: 'src/app.js', checks: {} },
    override: { verdict: 'SHIP', actor: 'carol', reason: 'break-glass deploy' },
  });
  assert.equal(result.policyEvaluation.verdict, 'BLOCKED');
  assert.equal(result.verdict, 'SHIP');
  assert.equal(result.overriddenFrom, 'BLOCKED');
  assert.deepEqual(result.overridden, {
    actor: 'carol',
    reason: 'break-glass deploy',
    from: 'BLOCKED',
    to: 'SHIP',
  });
});

test('rubber-stamp override throws (must change the verdict)', () => {
  clearAudit();
  assert.throws(
    () => computeVerdict([], new Set(), {
      ...META,
      override: { verdict: 'SHIP', actor: 'alice', reason: 'looks fine' },
    }),
    /override must change the verdict/,
  );
  assert.throws(
    () => computeVerdict([SEC_FINDING], new Set(), {
      ...META,
      override: { verdict: 'DO_NOT_SHIP', actor: 'alice', reason: 'looks bad' },
    }),
    /override must change the verdict/,
  );
  assert.throws(
    () => computeVerdict([], new Set(), {
      ...META,
      policy: { policies: [parsePolicy(GATED_YAML)], repo: 'acme/web', path: 'src/app.js', checks: {} },
      override: { verdict: 'BLOCKED', actor: 'alice', reason: 'same' },
    }),
    /must be SHIP or DO_NOT_SHIP/,
  );
  // The policy engine appends its own policy.evaluated event pre-existing
  // behavior; the invariant is that no verdict.overridden event is appended.
  assert.equal(
    listAudit().filter((e) => e.type === 'verdict.overridden').length,
    0,
    'rejected overrides append no verdict.overridden event',
  );
});

test('STALE override throws (freshness gate wins)', () => {
  clearAudit();
  assert.throws(
    () => computeVerdict([], new Set(), {
      ...META,
      override: { verdict: 'STALE', actor: 'alice', reason: 'stale please' },
    }),
    /must be SHIP or DO_NOT_SHIP/,
  );
  assert.equal(listAudit().length, 0, 'rejected overrides append no audit event');
});

test('malformed override throws fail-closed (no verdict, no audit)', () => {
  const cases = [
    ['missing verdict', { actor: 'a', reason: 'r' }],
    ['missing actor', { verdict: 'DO_NOT_SHIP', reason: 'r' }],
    ['missing reason', { verdict: 'DO_NOT_SHIP', actor: 'a' }],
    ['empty actor', { verdict: 'DO_NOT_SHIP', actor: '  ', reason: 'r' }],
    ['empty reason', { verdict: 'DO_NOT_SHIP', actor: 'a', reason: '' }],
    ['bad verdict', { verdict: 'MAYBE', actor: 'a', reason: 'r' }],
    ['null override fields', { verdict: null, actor: null, reason: null }],
  ];
  for (const [label, override] of cases) {
    clearAudit();
    assert.throws(
      () => computeVerdict([], new Set(), { ...META, override }),
      /override/i,
      label,
    );
    assert.equal(listAudit().length, 0, `no audit event for ${label}`);
  }
});

test('no-override shape unchanged (byte-identical pre-existing fields)', () => {
  clearAudit();
  const clean = computeVerdict([], new Set(), { ...META });
  assert.deepEqual(clean, {
    verdict: 'SHIP',
    headSha: 'h',
    baseSha: 'b',
    rulePackVersion: '1.0.0',
    blocking: [],
    silenced: [],
    nonBlocking: [],
    excluded: [],
    checksPassed: 6,
    policyEvaluation: null,
  });
  assert.deepEqual(
    Object.keys(clean).sort(),
    ['baseSha', 'blocking', 'checksPassed', 'excluded', 'headSha', 'nonBlocking', 'policyEvaluation', 'rulePackVersion', 'silenced', 'verdict'],
  );
  assert.ok(!('overridden' in clean), 'no overridden key without an override');
  assert.ok(!('overriddenFrom' in clean), 'no overriddenFrom key without an override');
  assert.equal(listAudit().length, 0, 'no audit event without an override');
});

test('human/json surfaces carry the OVERRIDDEN line only when overridden', () => {
  const plain = computeVerdict([], new Set(), { ...META });
  assert.ok(!formatHuman(plain, {}).includes('OVERRIDDEN'), 'no OVERRIDDEN line without an override');
  assert.ok(!('overridden' in toJson(plain, {})), 'no overridden key in json without an override');

  clearAudit();
  const over = computeVerdict([], new Set(), {
    ...META,
    override: { verdict: 'DO_NOT_SHIP', actor: 'alice', reason: 'incident-123' },
  });
  const human = formatHuman(over, {});
  assert.ok(
    human.includes(`OVERRIDDEN by alice (incident-123)${EM_DASH}was SHIP`),
    `missing OVERRIDDEN line:\n${human}`,
  );
  const json = toJson(over, {});
  assert.equal(json.verdict.decision, 'DO_NOT_SHIP');
  assert.deepEqual(json.overridden, {
    actor: 'alice',
    reason: 'incident-123',
    from: 'SHIP',
    to: 'DO_NOT_SHIP',
  });
  assert.equal(json.overriddenFrom, 'SHIP');
});

// --- CLI review --override ---

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

function scratch(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-override-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memPath(dir) {
  const p = path.join(dir, 'mem.jsonl');
  writeFileSync(p, '');
  return p;
}

function reviewArgs({ diff, mem, format, extra = [] }) {
  const args = [
    'review', '--diff', diff, '--repo', 'acme/web', '--head-sha', 'deadbeef',
    '--no-ledger', '--memory-path', mem,
  ];
  if (format) args.push('--format', format);
  return [...args, ...extra];
}

test('cli: --override without --override-reason fails closed with exit 2', (t) => {
  const dir = scratch(t);
  const r = runCli(reviewArgs({ diff: NEG_DIFF, mem: memPath(dir), extra: ['--override', 'DO_NOT_SHIP'] }));
  assert.equal(r.status, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /--override-reason/);
  assert.ok(!r.stdout.includes('SHIP'), 'no verdict on stdout');
  assert.ok(!r.stdout.includes('OVERRIDDEN'), 'no override line on stdout');
});

test('cli: --override with empty --override-reason fails closed with exit 2', (t) => {
  const dir = scratch(t);
  const r = runCli(reviewArgs({
    diff: NEG_DIFF, mem: memPath(dir),
    extra: ['--override', 'DO_NOT_SHIP', '--override-reason', ''],
  }));
  assert.equal(r.status, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /--override-reason/);
});

test('cli: invalid --override value fails closed with exit 2', (t) => {
  const dir = scratch(t);
  const r = runCli(reviewArgs({
    diff: NEG_DIFF, mem: memPath(dir),
    extra: ['--override', 'MAYBE', '--override-reason', 'x'],
  }));
  assert.equal(r.status, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /--override must be SHIP or DO_NOT_SHIP/);
});

test('cli: rubber-stamp override fails closed with exit 2', (t) => {
  const dir = scratch(t);
  const r = runCli(reviewArgs({
    diff: NEG_DIFF, mem: memPath(dir),
    extra: ['--override', 'SHIP', '--override-reason', 'rubber', '--override-actor', 'mallory'],
  }));
  assert.equal(r.status, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(r.stderr, /override must change the verdict/);
});

test('cli: override SHIP -> DO_NOT_SHIP prints OVERRIDDEN line + receipt', (t) => {
  const dir = scratch(t);
  const r = runCli(reviewArgs({
    diff: NEG_DIFF, mem: memPath(dir),
    extra: ['--override', 'DO_NOT_SHIP', '--override-reason', 'incident-123', '--override-actor', 'alice'],
  }));
  assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.ok(
    r.stdout.includes(`OVERRIDDEN by alice (incident-123)${EM_DASH}was SHIP`),
    `missing OVERRIDDEN line:\n${r.stdout}`,
  );
  assert.match(r.stdout, /receipt: \S+/);
  assert.ok(!r.stdout.includes('\x1b['), 'no ANSI escape codes when piped');
});

test('cli: override DO_NOT_SHIP -> SHIP prints OVERRIDDEN line + receipt', (t) => {
  const dir = scratch(t);
  const r = runCli(reviewArgs({
    diff: POS_DIFF, mem: memPath(dir),
    extra: ['--override', 'SHIP', '--override-reason', 'false positive', '--override-actor', 'bob'],
  }));
  assert.equal(r.status, 0, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.ok(
    r.stdout.includes(`OVERRIDDEN by bob (false positive)${EM_DASH}was DO_NOT_SHIP`),
    `missing OVERRIDDEN line:\n${r.stdout}`,
  );
  assert.match(r.stdout, /receipt: \S+/);
});

test('cli: override actor defaults without --override-actor', (t) => {
  const dir = scratch(t);
  const r = runCli(reviewArgs({
    diff: NEG_DIFF, mem: memPath(dir),
    extra: ['--override', 'DO_NOT_SHIP', '--override-reason', 'default-actor-probe'],
  }));
  assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
  assert.match(
    r.stdout,
    /OVERRIDDEN by \S+ \(default-actor-probe\) — was SHIP/,
    `missing defaulted OVERRIDDEN line:\n${r.stdout}`,
  );
});

test('cli: override visible in json with overridden fields', (t) => {
  const dir = scratch(t);
  const r = runCli(reviewArgs({
    diff: NEG_DIFF, mem: memPath(dir), format: 'json',
    extra: ['--override', 'DO_NOT_SHIP', '--override-reason', 'incident-123', '--override-actor', 'alice'],
  }));
  assert.equal(r.status, 1, `stdout=${r.stdout} stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict.decision, 'DO_NOT_SHIP');
  assert.deepEqual(out.overridden, {
    actor: 'alice',
    reason: 'incident-123',
    from: 'SHIP',
    to: 'DO_NOT_SHIP',
  });
  assert.equal(out.overriddenFrom, 'SHIP');
  assert.ok(out.receipt, 'receipt still recorded');
});

test('cli: no-flag review output carries no override surface', (t) => {
  const dir = scratch(t);
  const r = runCli(reviewArgs({ diff: NEG_DIFF, mem: memPath(dir) }));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SHIP — 0 findings/);
  assert.ok(!r.stdout.includes('OVERRIDDEN'), 'OVERRIDDEN line must be absent without --override');
});
