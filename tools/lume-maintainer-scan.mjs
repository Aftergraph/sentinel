#!/usr/bin/env node
import fs from 'node:fs'
import process from 'node:process'
import { analyzeDiff } from '../lib/review.js'
import { buildLumeRemediationTask } from '../lib/lume-maintainer.js'

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}

function fail(message) {
  console.error('lume-maintainer-scan: ' + message)
  process.exit(2)
}

const diffPath = arg('--diff')
const baseSha = arg('--base')
const headSha = arg('--head')
const policyPath = arg('--policy') || new URL('../ops/maintainers/lume.json', import.meta.url)
const outputPath = arg('--output')

if (!diffPath) fail('--diff is required')
if (!/^[0-9a-f]{40}$/i.test(baseSha || '')) fail('--base must be an exact 40-character SHA')
if (!/^[0-9a-f]{40}$/i.test(headSha || '')) fail('--head must be an exact 40-character SHA')

let diffText
let policy
try {
  diffText = fs.readFileSync(diffPath, 'utf8')
  policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'))
} catch (err) {
  fail('cannot read inputs: ' + err.message)
}

if (diffText.length > 5 * 1024 * 1024) fail('diff exceeds 5 MiB maintainer bound')

const { result } = await analyzeDiff({
  diffText,
  headSha,
  baseSha,
  resolutions: new Set(),
})

const findings = [...(result.blocking || []), ...(result.nonBlocking || [])]
const tasks = []
for (const finding of findings) {
  const { task, decision } = buildLumeRemediationTask({
    finding,
    baseSha: headSha,
    policy,
  })
  if (!task) continue
  tasks.push({
    task,
    decision,
    finding: {
      ruleId: finding.ruleId,
      file: finding.file,
      line: finding.line,
      evidence: finding.evidence,
    },
  })
}

const payload = {
  schema: 'aftergraph.sentinel-lume-maintainer-scan/v1',
  repo: 'Aftergraph/Lume',
  baseSha,
  headSha,
  findings: findings.length,
  tasks,
}

const json = JSON.stringify(payload, null, 2) + '\n'
if (outputPath) fs.writeFileSync(outputPath, json, 'utf8')
else process.stdout.write(json)
