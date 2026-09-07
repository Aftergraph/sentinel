import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePolicy,
  resolvePolicy,
  evaluatePolicy,
  policyVersion,
} from '../lib/policy.js';
import { list as auditList, clear as auditClear } from '../lib/audit.js';

const HAPPY = `apiVersion: sentinel.aftergraph/v1
kind: VerificationPolicy
metadata:
  name: web-strict
spec:
  scope:
    repo: acme/web
    paths:
      - "src/**"
  required:
    - sast
    - dast
  blocking_severity:
    - security
    - reliability
  approvals:
    required:
      - alice
`;

function doc(overrides = {}) {
  const base = parsePolicy(HAPPY);
  return { ...base, ...overrides };
}

test('parse: happy path returns versioned policy with pinned version', () => {
  const p = parsePolicy(HAPPY);
  assert.equal(p.apiVersion, 'sentinel.aftergraph/v1');
  assert.equal(p.kind, 'VerificationPolicy');
  assert.equal(p.metadata.name, 'web-strict');
  assert.deepEqual(p.spec.scope, { repo: 'acme/web', paths: ['src/**'] });
  assert.deepEqual(p.spec.required, ['sast', 'dast']);
  assert.deepEqual(p.spec.blocking_severity, ['security', 'reliability']);
  assert.deepEqual(p.spec.approvals, { required: ['alice'] });
  assert.match(p.policyVersion, /^web-strict@[0-9a-f]{16}$/);
  assert.equal(p.policyVersion, policyVersion(p));
});

test('parse: org-wide scope omits repo and defaults to null', () => {
  const p = parsePolicy(HAPPY.replace('    repo: acme/web\n', ''));
  assert.equal(p.spec.scope.repo, null);
});

test('parse: each malformed shape throws (fail closed)', () => {
  const cases = [
    ['bad apiVersion', HAPPY.replace('sentinel.aftergraph/v1', 'sentinel.aftergraph/v9')],
    ['bad kind', HAPPY.replace('VerificationPolicy', 'OtherPolicy')],
    ['missing name', HAPPY.replace('  name: web-strict\n', '')],
    ['numeric name', HAPPY.replace('name: web-strict', 'name: 123')],
    ['paths not an array', HAPPY.replace('- "src/**"', 'x')],
    ['paths with empty item', HAPPY.replace('- "src/**"', '- ""')],
    ['required not an array', HAPPY.replace('  required:\n    - sast\n    - dast', '  required: sast')],
    ['unknown blocking severity', HAPPY.replace('- reliability', '- critical')],
    ['approvals.required not an array', HAPPY.replace('    required:\n      - alice', '    required: alice')],
    ['missing blocking_severity', HAPPY.replace('  blocking_severity:\n    - security\n    - reliability\n', '')],
    ['empty input', '   \n'],
    ['garbage line', HAPPY.replace('  required:\n', '  just some words\n  required:\n')],
  ];
  assert.ok(cases.length >= 10);
  for (const [label, yaml] of cases) {
    assert.throws(() => parsePolicy(yaml), /Invalid policy/, label);
  }
});

const ORG = `apiVersion: sentinel.aftergraph/v1
kind: VerificationPolicy
metadata:
  name: org-default
spec:
  scope:
    paths: []
  required: []
  blocking_severity:
    - security
  approvals:
    required: []
`;

const REPO = ORG
  .replace('name: org-default', 'name: repo-default')
  .replace('    paths: []', '    repo: acme/web\n    paths: []');

const PATH_SRC = ORG
  .replace('name: org-default', 'name: path-src')
  .replace('    paths: []', '    repo: acme/web\n    paths:\n      - "src/**"');

const PATH_APP = ORG
  .replace('name: org-default', 'name: path-app')
  .replace('    paths: []', '    repo: acme/web\n    paths:\n      - "src/app/**"');

test('resolve: org -> repo -> path specificity', () => {
  const policies = [ORG, REPO, PATH_SRC].map(parsePolicy);
  assert.equal(resolvePolicy(policies, { repo: 'acme/web', path: 'src/app/main.js' }).metadata.name, 'path-src');
  assert.equal(resolvePolicy(policies, { repo: 'acme/web', path: 'README.md' }).metadata.name, 'repo-default');
  assert.equal(resolvePolicy(policies, { repo: 'acme/other', path: 'src/app/main.js' }).metadata.name, 'org-default');
});

test('resolve: longest path prefix wins', () => {
  const policies = [PATH_SRC, PATH_APP].map(parsePolicy);
  assert.equal(resolvePolicy(policies, { repo: 'acme/web', path: 'src/app/main.js' }).metadata.name, 'path-app');
  assert.equal(resolvePolicy(policies, { repo: 'acme/web', path: 'src/lib/util.js' }).metadata.name, 'path-src');
});

test('resolve: repo-level default wins when no path matches; throw when nothing matches', () => {
  const policies = [REPO, PATH_SRC].map(parsePolicy);
  assert.equal(resolvePolicy(policies, { repo: 'acme/web', path: 'docs/guide.md' }).metadata.name, 'repo-default');
  assert.throws(
    () => resolvePolicy(policies, { repo: 'acme/unknown', path: 'src/app/main.js' }),
    /No matching policy/,
  );
  assert.throws(() => resolvePolicy([], { repo: 'acme/web', path: 'x' }), /No matching policy/);
});

const CHECKS_OK = { sast: 'pass', dast: 'pass' };
const SEC_FINDING = {
  ruleId: 'no-eval-with-dynamic-input',
  file: 'src/app.js',
  line: 2,
  evidence: 'eval(x)',
};

test('evaluate: missing required check -> BLOCKED and audit emitted', () => {
  auditClear();
  const before = auditList().length;
  const r = evaluatePolicy(doc(), { findings: [], checks: { sast: 'pass' }, headSha: 'abc123' });
  assert.equal(r.verdict, 'BLOCKED');
  assert.equal(r.allowed, false);
  assert.ok(r.reasons.some((x) => x.includes('dast')), JSON.stringify(r.reasons));
  const events = auditList();
  assert.equal(events.length, before + 1);
  assert.equal(events.at(-1).type, 'policy.evaluated');
});

test('evaluate: in-scope blocking-severity finding -> DO_NOT_SHIP', () => {
  const r = evaluatePolicy(doc(), { findings: [SEC_FINDING], checks: CHECKS_OK, headSha: 'abc123' });
  assert.equal(r.verdict, 'DO_NOT_SHIP');
  assert.equal(r.allowed, false);
  assert.ok(r.reasons.some((x) => x.includes('src/app.js')));
});

test('evaluate: clean tree -> SHIP', () => {
  const r = evaluatePolicy(doc(), { findings: [], checks: CHECKS_OK, headSha: 'abc123' });
  assert.equal(r.verdict, 'SHIP');
  assert.equal(r.allowed, true);
  assert.equal(r.reasons.length, 1);
});

test('evaluate: out-of-scope and non-blocking findings do not block', () => {
  const outOfScope = { ...SEC_FINDING, file: 'docs/guide.md' };
  const style = { ruleId: 'no-var-instead-of-let-const', file: 'src/app.js', line: 1, evidence: 'var x = 1;' };
  const r = evaluatePolicy(doc(), { findings: [outOfScope, style], checks: CHECKS_OK, headSha: 'abc123' });
  assert.equal(r.verdict, 'SHIP');
  assert.equal(r.allowed, true);
});

test('evaluate: failed required check -> DO_NOT_SHIP', () => {
  const r = evaluatePolicy(doc(), {
    findings: [],
    checks: { sast: { status: 'failed' }, dast: 'pass' },
    headSha: 'abc123',
  });
  assert.equal(r.verdict, 'DO_NOT_SHIP');
  assert.equal(r.allowed, false);
  assert.ok(r.reasons.some((x) => x.includes('sast')));
});

test('evaluate: policyVersion pinned and every evaluation emits an audit event', () => {
  auditClear();
  const policy = doc();
  const a = evaluatePolicy(policy, { findings: [], checks: CHECKS_OK, headSha: 'abc123' });
  const b = evaluatePolicy(policy, { findings: [SEC_FINDING], checks: CHECKS_OK, headSha: 'abc123' });
  assert.equal(a.policyVersion, policyVersion(policy));
  assert.equal(b.policyVersion, a.policyVersion);
  const events = auditList();
  assert.equal(events.length, 2);
  for (const [event, verdict] of [[events[0], 'SHIP'], [events[1], 'DO_NOT_SHIP']]) {
    assert.equal(event.type, 'policy.evaluated');
    assert.equal(event.to, verdict);
    assert.ok(event.reason.includes(a.policyVersion), event.reason);
    assert.ok(event.reason.includes(verdict), event.reason);
  }
  const tampered = structuredClone(policy);
  tampered.spec.blocking_severity = ['security'];
  assert.notEqual(policyVersion(tampered), a.policyVersion);
});
