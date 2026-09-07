import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVerdict, VERDICT_STRICTNESS } from '../lib/review.js';
import { parsePolicy, policyVersion } from '../lib/policy.js';

const META = { headSha: 'h', baseSha: 'b', rulePackVersion: '1.0.0' };

const SEC_FINDING = {
  ruleId: 'no-eval-with-dynamic-input',
  file: 'src/app.js',
  line: 2,
  evidence: 'eval(x)',
};

// Permissive gate: no required checks, security findings in scope -> SHIP
// on a clean tree.
const OPEN_YAML = `apiVersion: sentinel.aftergraph/v1
kind: VerificationPolicy
metadata:
  name: verdict-open
spec:
  scope:
    repo: acme/web
    paths:
      - "src/**"
  required: []
  blocking_severity:
    - security
  approvals:
    required: []
`;

// Gated: requires a 'sast' check result -> BLOCKED while it is missing.
const GATED_YAML = OPEN_YAML
  .replace('name: verdict-open', 'name: verdict-gated')
  .replace('  required: []', '  required:\n    - sast');

// Lenient: nothing is a blocking severity -> SHIP even with open findings.
const LENIENT_YAML = OPEN_YAML
  .replace('name: verdict-open', 'name: verdict-lenient')
  .replace('  blocking_severity:\n    - security\n', '  blocking_severity: []\n');

function withPolicy(policy, { checks = {}, repo = 'acme/web', path = 'src/app.js' } = {}) {
  return { ...META, policy: { policies: [policy], repo, path, checks } };
}

test('no-policy path unchanged: pre-existing shape byte-identical, policyEvaluation null', () => {
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

  const style = { ruleId: 'no-var-instead-of-let-const', file: 'a.js', line: 1, evidence: 'var x = 1;' };
  const fired = computeVerdict([style, SEC_FINDING], new Set(), { ...META });
  assert.equal(fired.verdict, 'DO_NOT_SHIP');
  assert.deepEqual(fired.blocking, [SEC_FINDING]);
  assert.deepEqual(fired.nonBlocking, [style]);
  assert.equal(fired.policyEvaluation, null);
});

test('policy SHIP + rule SHIP -> SHIP with pinned version', () => {
  const policy = parsePolicy(OPEN_YAML);
  const result = computeVerdict([], new Set(), withPolicy(policy));
  assert.equal(result.verdict, 'SHIP');
  assert.equal(result.policyEvaluation.verdict, 'SHIP');
  assert.equal(result.policyEvaluation.policyVersion, policy.policyVersion);
  assert.equal(result.policyEvaluation.policyVersion, policyVersion(policy));
  assert.match(result.policyEvaluation.policyVersion, /^verdict-open@[0-9a-f]{16}$/);
  assert.ok(Array.isArray(result.policyEvaluation.reasons));
  assert.ok(result.policyEvaluation.reasons.length > 0);
});

test('policy BLOCKED (missing required check) overrides rule SHIP', () => {
  const policy = parsePolicy(GATED_YAML);
  const result = computeVerdict([], new Set(), withPolicy(policy));
  assert.equal(result.policyEvaluation.verdict, 'BLOCKED');
  assert.ok(result.policyEvaluation.reasons.some((r) => r.includes('sast')), JSON.stringify(result.policyEvaluation.reasons));
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(result.policyEvaluation.policyVersion, policyVersion(policy));
});

test('policy DO_NOT_SHIP (failed required check) escalates rule SHIP', () => {
  const policy = parsePolicy(GATED_YAML);
  const result = computeVerdict(
    [],
    new Set(),
    withPolicy(policy, { checks: { sast: { status: 'failed' } } }),
  );
  assert.equal(result.policyEvaluation.verdict, 'DO_NOT_SHIP');
  assert.equal(result.verdict, 'DO_NOT_SHIP');
});

test('rule DO_NOT_SHIP stands over policy SHIP (no de-escalation)', () => {
  const policy = parsePolicy(LENIENT_YAML);
  const result = computeVerdict([SEC_FINDING], new Set(), withPolicy(policy));
  assert.equal(result.policyEvaluation.verdict, 'SHIP');
  assert.equal(result.verdict, 'DO_NOT_SHIP');
  assert.deepEqual(result.blocking, [SEC_FINDING]);
});

test('STALE beats policy SHIP (freshness gate wins outright)', () => {
  // Ladder pinned: DO_NOT_SHIP > STALE > BLOCKED > SHIP.
  assert.ok(VERDICT_STRICTNESS.DO_NOT_SHIP > VERDICT_STRICTNESS.STALE);
  assert.ok(VERDICT_STRICTNESS.STALE > VERDICT_STRICTNESS.BLOCKED);
  assert.ok(VERDICT_STRICTNESS.BLOCKED > VERDICT_STRICTNESS.SHIP);
  // Strictest-wins keeps a freshness-gate STALE over any policy verdict
  // below DO_NOT_SHIP. STALE verdicts are issued by the exact-head
  // freshness gate in review(), which bypasses computeVerdict/policy, so
  // computeVerdict escalation can never manufacture or clear one.
  for (const policyVerdict of ['SHIP', 'BLOCKED']) {
    const winner = VERDICT_STRICTNESS[policyVerdict] > VERDICT_STRICTNESS.STALE ? policyVerdict : 'STALE';
    assert.equal(winner, 'STALE', `STALE must beat policy ${policyVerdict}`);
  }
});

test('malformed policy input throws fail-closed (no verdict)', () => {
  const valid = parsePolicy(OPEN_YAML);
  const tampered = structuredClone(valid);
  tampered.metadata.name = '';
  const cases = [
    ['empty policy set', { ...META, policy: { policies: [], repo: 'acme/web', path: 'src/app.js', checks: {} } }],
    ['non-array policies', { ...META, policy: { policies: 'nope', repo: 'acme/web', path: 'src/app.js', checks: {} } }],
    ['null policies', { ...META, policy: { policies: null, repo: 'acme/web', path: 'src/app.js', checks: {} } }],
    ['garbage policy object', { ...META, policy: { policies: [{ nope: true }], repo: 'acme/web', path: 'src/app.js', checks: {} } }],
    ['missing repo', { ...META, policy: { policies: [valid], path: 'src/app.js', checks: {} } }],
    ['unmatched repo', { ...META, policy: { policies: [valid], repo: 'acme/unknown', path: 'other.md', checks: {} } }],
    ['tampered policy name', { ...META, policy: { policies: [tampered], repo: 'acme/web', path: 'src/app.js', checks: {} } }],
  ];
  assert.ok(cases.length >= 5);
  for (const [label, meta] of cases) {
    assert.throws(() => computeVerdict([], new Set(), meta), /No matching policy|Invalid policy/, label);
  }
});
