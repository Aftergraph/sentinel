import { createHash } from 'node:crypto'
import { SEVERITY_MAP } from './rulepack.js'
import { ACTIONS, evaluateMaintainerCandidate } from './maintainer-policy.js'

const RISK_BY_SEVERITY = Object.freeze({
  style: 'low',
  performance: 'low',
  correctness: 'medium',
  reliability: 'medium',
  data: 'high',
  security: 'critical',
})

function idOf(parts) {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 20)
}

export function findingRisk(severity) {
  return RISK_BY_SEVERITY[severity] ?? 'critical'
}

export function buildLumeRemediationTask({ finding, baseSha, policy, repo = 'Aftergraph/Lume' } = {}) {
  if (!finding || typeof finding !== 'object') throw new TypeError('finding is required')
  if (typeof baseSha !== 'string' || !/^[0-9a-f]{40}$/i.test(baseSha)) throw new TypeError('baseSha must be exact SHA')
  const severity = SEVERITY_MAP[finding.ruleId] || 'security'
  const path = typeof finding.file === 'string' ? finding.file : ''
  const risk = findingRisk(severity)

  const decision = evaluateMaintainerCandidate(policy, {
    repo,
    severity,
    risk,
    paths: path ? [path] : [],
    exactHead: true,
  })
  if (decision.action !== ACTIONS.DISPATCH_REMEDIATION) return { task: null, decision }

  const fingerprint = idOf([
    repo,
    baseSha,
    String(finding.ruleId || ''),
    path,
    String(finding.line || ''),
    String(finding.evidence || ''),
  ])

  const task = {
    apiVersion: 'sentinel.aftergraph/v1alpha1',
    kind: 'LumeRemediationTask',
    id: 'sentinel:' + fingerprint,
    repo,
    baseSha,
    findingId: fingerprint,
    summary: `[${finding.ruleId}] ${String(finding.evidence || 'Sentinel finding')}`,
    paths: [path],
    policyReceipt: 'sentinel-maintainer:' + fingerprint,
    sentinelVerified: true,
    autoMergeEligible: Boolean(decision.autoMergeEligible),
  }
  return { task, decision }
}

export function issueForLumeRemediationTask(task) {
  if (!task || task.kind !== 'LumeRemediationTask') throw new TypeError('LumeRemediationTask required')
  const title = `[sentinel-remediate] ${task.findingId} ${task.paths[0]}`
  return { title, body: JSON.stringify(task, null, 2) }
}
