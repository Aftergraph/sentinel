import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeVerdict, toGov, toSarif } from '../lib/review.js';
import { parsePolicy } from '../lib/policy.js';
import { clear as clearAudit } from '../lib/audit.js';

const META = { headSha: 'h', baseSha: 'b', rulePackVersion: '1.0.0' };
const GOV_CTX = { repo: 'o/r', prNumber: 7, source: 'manual', environment: null, runId: 'r1' };

const SEC_FINDING = { ruleId: 'no-eval-with-dynamic-input', file: 'src/app.js', line: 2, evidence: 'eval(x)' };

// Gated policy: requires a 'sast' check result -> BLOCKED while missing.
const GATED_YAML = `apiVersion: sentinel.aftergraph/v1
kind: VerificationPolicy
metadata:
  name: gov-policy-gated
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

function gatedMeta(extra = {}) {
  return {
    ...META,
    policy: { policies: [parsePolicy(GATED_YAML)], repo: 'acme/web', path: 'src/app.js', checks: {} },
    ...extra,
  };
}

function govResultEntriesOnlyContextStatus(gov) {
  for (const r of gov.results) {
    assert.deepEqual(Object.keys(r).sort(), ['context', 'status'], `entry must stay GitHub-compatible: ${JSON.stringify(r)}`);
  }
}

test('gov: policy attestation flows with pinned policyVersion; verdict entry maps by final verdict', () => {
  const result = computeVerdict([], new Set(), gatedMeta());
  assert.equal(result.verdict, 'BLOCKED');
  const gov = toGov(result, GOV_CTX);
  assert.equal(gov.policyEvaluation.policyVersion, result.policyEvaluation.policyVersion);
  assert.match(gov.policyEvaluation.policyVersion, /^gov-policy-gated@[0-9a-f]{16}$/);
  assert.equal(gov.policyEvaluation.verdict, 'BLOCKED');
  const byCtx = Object.fromEntries(gov.results.map((r) => [r.context, r.status]));
  assert.equal(byCtx['sentinel/verdict'], 'failure');
  govResultEntriesOnlyContextStatus(gov);
});

test('gov: overridden DO_NOT_SHIP -> SHIP maps success by FINAL verdict, keeps was', () => {
  clearAudit();
  const result = computeVerdict([SEC_FINDING], new Set(), {
    ...META,
    override: { verdict: 'SHIP', actor: 'bob', reason: 'hand-verified' },
  });
  const gov = toGov(result, GOV_CTX);
  const byCtx = Object.fromEntries(gov.results.map((r) => [r.context, r.status]));
  assert.equal(byCtx['sentinel/verdict'], 'success');
  assert.deepEqual(gov.overridden, { actor: 'bob', reason: 'hand-verified', from: 'DO_NOT_SHIP', to: 'SHIP' });
  assert.equal(gov.overriddenFrom, 'DO_NOT_SHIP');
  govResultEntriesOnlyContextStatus(gov);
});

test('gov: overridden SHIP -> DO_NOT_SHIP maps failure by FINAL verdict, keeps was', () => {
  clearAudit();
  const result = computeVerdict([], new Set(), {
    ...META,
    override: { verdict: 'DO_NOT_SHIP', actor: 'alice', reason: 'incident-123' },
  });
  const gov = toGov(result, GOV_CTX);
  const byCtx = Object.fromEntries(gov.results.map((r) => [r.context, r.status]));
  assert.equal(byCtx['sentinel/verdict'], 'failure');
  assert.equal(gov.overridden.from, 'SHIP');
  assert.equal(gov.overriddenFrom, 'SHIP');
  govResultEntriesOnlyContextStatus(gov);
});

test('gov: STALE still maps to a single cancelled entry', () => {
  const stale = {
    verdict: 'STALE', headSha: 'h', baseSha: 'b', rulePackVersion: '1.0.0',
    blocking: [], silenced: [], nonBlocking: [], excluded: [], checksPassed: 6,
  };
  const gov = toGov(stale, GOV_CTX);
  assert.deepEqual(gov.results, [{ context: 'sentinel/review', status: 'cancelled' }]);
  assert.ok(!('policyEvaluation' in gov));
  assert.ok(!('overridden' in gov));
});

test('gov: no-policy/no-override output gains no new keys', () => {
  const clean = computeVerdict([], new Set(), { ...META });
  const gov = toGov(clean, GOV_CTX);
  assert.ok(!('policyEvaluation' in gov));
  assert.ok(!('overridden' in gov));
  assert.ok(!('overriddenFrom' in gov));
});

test('sarif: policy + override attestation in run properties and verdict envelope; levels stay valid', () => {
  clearAudit();
  const policy = parsePolicy(GATED_YAML);
  const result = computeVerdict([SEC_FINDING], new Set(), {
    ...META,
    policy: { policies: [policy], repo: 'acme/web', path: 'src/app.js', checks: {} },
    override: { verdict: 'SHIP', actor: 'carol', reason: 'break-glass' },
  });
  assert.equal(result.verdict, 'SHIP');
  const wrap = toSarif(result);
  assert.equal(wrap.verdict.policyEvaluation.policyVersion, policy.policyVersion);
  assert.deepEqual(wrap.verdict.overridden, { actor: 'carol', reason: 'break-glass', from: 'DO_NOT_SHIP', to: 'SHIP' });
  assert.equal(wrap.verdict.overriddenFrom, 'DO_NOT_SHIP');
  const run = wrap.sarif.runs[0];
  assert.equal(run.properties.policyEvaluation.policyVersion, policy.policyVersion);
  assert.equal(run.properties.overriddenFrom, 'DO_NOT_SHIP');
  assert.equal(run.results.length, 1);
  for (const r of run.results) {
    assert.ok(['error', 'warning', 'note'].includes(r.level), `valid level: ${r.level}`);
  }
});

test('sarif: no-policy/no-override output gains no new keys', () => {
  const clean = computeVerdict([SEC_FINDING], new Set(), { ...META });
  const wrap = toSarif(clean);
  assert.deepEqual(Object.keys(wrap.verdict).sort(), ['baseSha', 'headSha', 'rulePackVersion', 'verdict']);
  assert.ok(!('properties' in wrap.sarif.runs[0]));
});
