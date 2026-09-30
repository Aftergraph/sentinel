import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePolicy, evaluatePolicy, isVerdictCurrent } from '../lib/policy.js';

// A verdict is evidence about the exact commit it was evaluated on. A rebase or
// a new commit produces a different subject, and the prior verdict must not
// satisfy verification for it (issue #35).

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
const OK = { sast: 'pass' };

test('subject: a verdict carries the exact head it was evaluated on', () => {
  const r = evaluatePolicy(doc(), { findings: [], checks: OK, headSha: SHA_A });
  assert.equal(r.verdict, 'SHIP');
  assert.equal(r.subject.headSha, SHA_A);
  assert.equal(r.subject.exact, true);
  assert.equal(r.verifier, 'sentinel:policy-engine');
  assert.match(r.verdictId, /^[0-9a-f]{64}$/u);
  assert.ok(!Number.isNaN(Date.parse(r.evaluatedAt)));
});

test('subject: a PASS on A does not satisfy verification for B', () => {
  const r = evaluatePolicy(doc(), { findings: [], checks: OK, headSha: SHA_A });
  assert.equal(isVerdictCurrent(r, SHA_A).current, true);
  const stale = isVerdictCurrent(r, SHA_B);
  assert.equal(stale.current, false);
  assert.match(stale.reason, /stale verdict/u);
});

test('subject: the same inputs on the same head are content-addressed alike', () => {
  const a = evaluatePolicy(doc(), { findings: [], checks: OK, headSha: SHA_A });
  const b = evaluatePolicy(doc(), { findings: [], checks: OK, headSha: SHA_A });
  const other = evaluatePolicy(doc(), { findings: [], checks: OK, headSha: SHA_B });
  assert.equal(a.verdictId, b.verdictId);
  assert.notEqual(a.verdictId, other.verdictId);
});

test('subject: an inexact head stays indeterminate and is never current', () => {
  const short = evaluatePolicy(doc(), { findings: [], checks: OK, headSha: 'abc1234' });
  assert.equal(short.subject.exact, false);
  assert.equal(isVerdictCurrent(short, 'abc1234').current, false);

  const unknown = evaluatePolicy(doc(), { findings: [], checks: OK });
  assert.equal(unknown.subject.headSha, 'unknown');
  assert.equal(unknown.subject.exact, false);
  assert.equal(isVerdictCurrent(unknown, SHA_A).current, false);
});

test('subject: a candidate head that is not an exact sha cannot be satisfied', () => {
  const r = evaluatePolicy(doc(), { findings: [], checks: OK, headSha: SHA_A });
  const res = isVerdictCurrent(r, 'main');
  assert.equal(res.current, false);
  assert.match(res.reason, /not an exact commit sha/u);
});

test('subject: a blocked verdict is bound to its head like any other', () => {
  const r = evaluatePolicy(doc(), { findings: [], checks: {}, headSha: SHA_A });
  assert.equal(r.verdict, 'BLOCKED');
  assert.equal(r.subject.headSha, SHA_A);
  assert.equal(isVerdictCurrent(r, SHA_B).current, false);
  assert.equal(isVerdictCurrent(r, SHA_A).current, true);
});

test('subject: a malformed verdict object is never current', () => {
  assert.equal(isVerdictCurrent(null, SHA_A).current, false);
  assert.equal(isVerdictCurrent({ verdict: 'SHIP' }, SHA_A).current, false);
});
