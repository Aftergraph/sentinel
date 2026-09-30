import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicy, evaluatePolicy } from '../lib/policy.js';

// A verdict decided by required checks must still report the blocking findings
// the same run already computed, so one review round says everything known.

const POLICY = `apiVersion: sentinel.aftergraph/v1
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

const doc = () => parsePolicy(POLICY);

const SECRET = {
  ruleId: 'no-hardcoded-secret',
  file: 'src/config.js',
  line: 12,
  evidence: 'const key = "AKIA..."',
  severity: 'security',
};

test('co-report: BLOCKED still names the blocking finding in the same round', () => {
  const r = evaluatePolicy(doc(), {
    findings: [SECRET],
    checks: { sast: 'pass' },
    headSha: 'abc123',
  });
  assert.equal(r.verdict, 'BLOCKED');
  assert.equal(r.allowed, false);
  assert.ok(r.reasons.some((x) => x.includes('missing required check')), JSON.stringify(r.reasons));
  assert.ok(r.reasons.some((x) => x.includes('src/config.js')), JSON.stringify(r.reasons));
});

test('co-report: a failed check does not hide the blocking finding', () => {
  const r = evaluatePolicy(doc(), {
    findings: [SECRET],
    checks: { sast: { status: 'failed' }, dast: 'pass' },
    headSha: 'abc123',
  });
  assert.equal(r.verdict, 'DO_NOT_SHIP');
  assert.ok(r.reasons.some((x) => x.includes('required check "sast" failed')), JSON.stringify(r.reasons));
  assert.ok(r.reasons.some((x) => x.startsWith('also blocking finding:')), JSON.stringify(r.reasons));
});

test('co-report: a finding-decided verdict is not duplicated', () => {
  const r = evaluatePolicy(doc(), {
    findings: [SECRET],
    checks: { sast: 'pass', dast: 'pass' },
    headSha: 'abc123',
  });
  assert.equal(r.verdict, 'DO_NOT_SHIP');
  assert.equal(r.reasons.length, 1);
  assert.ok(!r.reasons.some((x) => x.startsWith('also ')), JSON.stringify(r.reasons));
});

test('co-report: out-of-scope findings stay out of the reasons', () => {
  const outOfScope = { ...SECRET, file: 'docs/guide.md' };
  const r = evaluatePolicy(doc(), {
    findings: [outOfScope],
    checks: { sast: 'pass' },
    headSha: 'abc123',
  });
  assert.equal(r.verdict, 'BLOCKED');
  assert.equal(r.reasons.length, 1);
  assert.ok(r.reasons[0].includes('dast'), JSON.stringify(r.reasons));
});

test('co-report: the verdict itself is unchanged by co-reporting', () => {
  const clean = evaluatePolicy(doc(), { findings: [], checks: { sast: 'pass', dast: 'pass' }, headSha: 'abc' });
  assert.equal(clean.verdict, 'SHIP');
  assert.equal(clean.allowed, true);
  assert.equal(clean.reasons.length, 1);
});
