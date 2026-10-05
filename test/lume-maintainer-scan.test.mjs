import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = path.resolve('.')
const cli = path.join(root, 'tools', 'lume-maintainer-scan.mjs')
const policy = path.join(root, 'ops', 'maintainers', 'lume.json')

function run(diff) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-scan-'))
  const diffPath = path.join(dir, 'change.diff')
  fs.writeFileSync(diffPath, diff)
  const r = spawnSync(process.execPath, [
    cli,
    '--diff', diffPath,
    '--base', 'a'.repeat(40),
    '--head', 'b'.repeat(40),
    '--policy', policy,
  ], { encoding: 'utf8' })
  return r
}

test('CLI emits deterministic remediation tasks for eligible Lume changes', () => {
  const r = run([
    'diff --git a/src/x.js b/src/x.js',
    '--- a/src/x.js',
    '+++ b/src/x.js',
    '@@ -1 +1 @@',
    '-if (a === b) {}',
    '+if (a == b) {}',
    '',
  ].join('\n'))
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.schema, 'aftergraph.sentinel-lume-maintainer-scan/v1')
  assert.equal(out.headSha, 'b'.repeat(40))
  assert.ok(out.tasks.length >= 1)
  assert.equal(out.tasks[0].task.repo, 'Aftergraph/Lume')
  assert.equal(out.tasks[0].task.baseSha, 'b'.repeat(40))
})

test('CLI refuses malformed exact-head inputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-scan-'))
  const diffPath = path.join(dir, 'change.diff')
  fs.writeFileSync(diffPath, '')
  const r = spawnSync(process.execPath, [
    cli,
    '--diff', diffPath,
    '--base', 'main',
    '--head', 'b'.repeat(40),
    '--policy', policy,
  ], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /exact 40-character SHA/)
})
