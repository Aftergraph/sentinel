import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS, evaluateMaintainerPolicy, parseMaintainerPolicy } from '../lib/maintainer-policy.js';

const base = {
  apiVersion: 'sentinel.aftergraph/v1alpha1',
  kind: 'AutonomousMaintainerPolicy',
  metadata: { name: 'lume' },
  spec: {
    repo: 'Aftergraph/Lume',
    enabled: true,
    allowedSeverities: ['reliability', 'correctness', 'performance', 'style'],
    maxRisk: 'medium',
    allowedPaths: ['src/**', 'server/**', 'tests/**'],
    protectedPaths: ['.github/workflows/**', 'server/identity.js'],
    requireExactHead: true,
    requireSentinelVerification: true,
    requireIndependentChecks: ['CI', 'Sentinel gate'],
    allowAutoMerge: true,
  },
};

test('parses a valid governed maintainer policy and hard-disables direct main/deploy', () => {
  const p = parseMaintainerPolicy(base);
  assert.equal(p.repo, 'Aftergraph/Lume');
  assert.equal(p.allowAutoMerge, true);
  assert.equal(p.allowDirectMain, false);
  assert.equal(p.allowDirectDeploy, false);
});

test('permits only PR remediation inside the autonomy envelope', () => {
  const result = evaluateMaintainerPolicy(base, {
    repo: 'Aftergraph/Lume',
    severity: 'correctness',
    risk: 'medium',
    paths: ['src/App.tsx', 'tests/app.test.mjs'],
    exactHead: true,
    sentinelVerified: true,
    passedChecks: ['CI', 'Sentinel gate'],
  });
  assert.deepEqual(result, {
    action: ACTIONS.REMEDIATE_PR,
    reason: 'within-autonomy-envelope',
    autoMergeEligible: true,
    directMainAllowed: false,
    directDeployAllowed: false,
  });
});

test('protected paths fail closed', () => {
  const result = evaluateMaintainerPolicy(base, {
    repo: 'Aftergraph/Lume',
    severity: 'reliability',
    risk: 'low',
    paths: ['server/identity.js'],
    exactHead: true,
    sentinelVerified: true,
    passedChecks: ['CI', 'Sentinel gate'],
  });
  assert.equal(result.action, ACTIONS.BLOCKED);
  assert.equal(result.reason, 'protected-path');
});

test('high-risk work is proposal-only', () => {
  const result = evaluateMaintainerPolicy(base, {
    repo: 'Aftergraph/Lume',
    severity: 'correctness',
    risk: 'high',
    paths: ['src/App.tsx'],
    exactHead: true,
    sentinelVerified: true,
    passedChecks: ['CI', 'Sentinel gate'],
  });
  assert.equal(result.action, ACTIONS.PROPOSE);
  assert.equal(result.reason, 'risk-outside-autonomy');
});

test('missing independent verification cannot enter remediation', () => {
  const result = evaluateMaintainerPolicy(base, {
    repo: 'Aftergraph/Lume',
    severity: 'performance',
    risk: 'low',
    paths: ['server/cache.js'],
    exactHead: true,
    sentinelVerified: true,
    passedChecks: ['CI'],
  });
  assert.equal(result.action, ACTIONS.PROPOSE);
  assert.equal(result.reason, 'independent-checks-required');
  assert.deepEqual(result.missingChecks, ['Sentinel gate']);
});

test('unknown policy values throw instead of weakening autonomy', () => {
  const malformed = structuredClone(base);
  malformed.spec.maxRisk = 'whatever';
  assert.throws(() => parseMaintainerPolicy(malformed), /unknown maxRisk/);
});


test('path globs are anchored and distinguish one-segment from recursive matches', () => {
  const recursive = evaluateMaintainerPolicy(base, {
    repo: 'Aftergraph/Lume',
    severity: 'correctness',
    risk: 'low',
    paths: ['src/features/agent/runtime.ts'],
    exactHead: true,
    sentinelVerified: true,
    passedChecks: ['CI', 'Sentinel gate'],
  });
  assert.equal(recursive.action, ACTIONS.REMEDIATE_PR);

  const escaped = structuredClone(base);
  escaped.spec.allowedPaths = ['src/*.ts'];
  const nested = evaluateMaintainerPolicy(escaped, {
    repo: 'Aftergraph/Lume',
    severity: 'correctness',
    risk: 'low',
    paths: ['src/features/runtime.ts'],
    exactHead: true,
    sentinelVerified: true,
    passedChecks: ['CI', 'Sentinel gate'],
  });
  assert.equal(nested.action, ACTIONS.PROPOSE);
  assert.equal(nested.reason, 'path-outside-autonomy');
});
