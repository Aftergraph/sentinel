import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicy, evaluatePolicy } from '../lib/policy.js';

// A check result that names the commit it ran on is evidence about THAT commit.
// Pointed at a different head it is stale, not passing (issue #22).

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
  blocking_severity:
    - security
  approvals:
    required:
      - alice
`;

const doc = () => parsePolicy(POLICY);
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('evidence: a pass from another commit does not satisfy this head', () => {
  const r = evaluatePolicy(doc(), {
    findings: [],
    checks: { sast: { status: 'pass', headSha: SHA_A } },
    headSha: SHA_B,
  });
  assert.equal(r.verdict, 'BLOCKED');
  assert.equal(r.allowed, false);
  assert.ok(r.reasons.some((x) => x.startsWith('stale required check:')), JSON.stringify(r.reasons));
});

test('evidence: a pass from this head still satisfies it', () => {
  const r = evaluatePolicy(doc(), {
    findings: [],
    checks: { sast: { status: 'pass', headSha: SHA_A } },
    headSha: SHA_A,
  });
  assert.equal(r.verdict, 'SHIP');
  assert.equal(r.allowed, true);
});

test('evidence: a stale failure is not reported as a failure either', () => {
  const r = evaluatePolicy(doc(), {
    findings: [],
    checks: { sast: { status: 'failed', commit: SHA_A } },
    headSha: SHA_B,
  });
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(!r.reasons.some((x) => x.includes('failed')), JSON.stringify(r.reasons));
});

test('evidence: array-form results are bound the same way', () => {
  const stale = evaluatePolicy(doc(), {
    findings: [],
    checks: [{ name: 'sast', passed: true, sha: SHA_A }],
    headSha: SHA_B,
  });
  assert.equal(stale.verdict, 'BLOCKED');

  const fresh = evaluatePolicy(doc(), {
    findings: [],
    checks: [{ name: 'sast', passed: true, sha: SHA_B }],
    headSha: SHA_B,
  });
  assert.equal(fresh.verdict, 'SHIP');
});

test('evidence: a result naming no commit behaves exactly as before', () => {
  const r = evaluatePolicy(doc(), { findings: [], checks: { sast: 'pass' }, headSha: SHA_A });
  assert.equal(r.verdict, 'SHIP');

  const failing = evaluatePolicy(doc(), { findings: [], checks: { sast: 'failed' }, headSha: SHA_A });
  assert.equal(failing.verdict, 'DO_NOT_SHIP');
});

test('evidence: without an exact head nothing is judged stale', () => {
  const r = evaluatePolicy(doc(), {
    findings: [],
    checks: { sast: { status: 'pass', headSha: SHA_A } },
    headSha: 'main',
  });
  assert.equal(r.verdict, 'SHIP');
  assert.equal(r.subject.exact, false);
});

test('evidence: a stale check still co-reports the blocking finding', () => {
  const r = evaluatePolicy(doc(), {
    findings: [{ ruleId: 'no-hardcoded-secret', file: 'src/config.js', severity: 'security' }],
    checks: { sast: { status: 'pass', headSha: SHA_A } },
    headSha: SHA_B,
  });
  assert.equal(r.verdict, 'BLOCKED');
  assert.ok(r.reasons.some((x) => x.startsWith('stale required check:')), JSON.stringify(r.reasons));
  assert.ok(r.reasons.some((x) => x.includes('src/config.js')), JSON.stringify(r.reasons));
});
