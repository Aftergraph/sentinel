import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLumeRemediationTask, findingRisk, issueForLumeRemediationTask } from '../lib/lume-maintainer.js'

const policy = {
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
    requireIndependentChecks: ['CI'],
    allowAutoMerge: true,
  },
}

test('maps finding severity to bounded remediation risk', () => {
  assert.equal(findingRisk('style'), 'low')
  assert.equal(findingRisk('correctness'), 'medium')
  assert.equal(findingRisk('security'), 'critical')
})

test('eligible Lume finding becomes deterministic exact-head task', () => {
  const finding = { ruleId: 'require-strict-equality', file: 'src/App.tsx', line: 12, evidence: 'Use strict equality.' }
  const baseSha = 'a'.repeat(40)
  const a = buildLumeRemediationTask({ finding, baseSha, policy })
  const b = buildLumeRemediationTask({ finding, baseSha, policy })
  assert.deepEqual(a.task, b.task)
  assert.equal(a.task.baseSha, baseSha)
  assert.deepEqual(a.task.paths, ['src/App.tsx'])
  assert.equal(a.task.autoMergeEligible, true)
})

test('protected and high-risk findings do not dispatch', () => {
  const protectedFinding = { ruleId: 'require-strict-equality', file: '.github/workflows/ci.yml', line: 3, evidence: 'x' }
  assert.equal(buildLumeRemediationTask({ finding: protectedFinding, baseSha: 'b'.repeat(40), policy }).task, null)

  const securityFinding = { ruleId: 'security-secret', file: 'src/x.js', line: 1, evidence: 'secret' }
  assert.equal(buildLumeRemediationTask({ finding: securityFinding, baseSha: 'c'.repeat(40), policy }).task, null)
})

test('issue body is pure machine-readable task JSON', () => {
  const finding = { ruleId: 'require-strict-equality', file: 'src/App.tsx', line: 12, evidence: 'Use strict equality.' }
  const { task } = buildLumeRemediationTask({ finding, baseSha: 'd'.repeat(40), policy })
  const issue = issueForLumeRemediationTask(task)
  assert.match(issue.title, /^\[sentinel-remediate\]/)
  assert.deepEqual(JSON.parse(issue.body), task)
})
