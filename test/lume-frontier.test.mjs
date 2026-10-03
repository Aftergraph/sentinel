// Lume frontier environment tests.
//
// The frontier pack in ops/frontier/lume/ must be internally consistent and
// its harness must behave fail-closed in both directions: a compliant proxy
// passes every scenario, and each sabotage class is detected. These tests
// exercise the pack the way CI would, so a regression in the harness or a
// malformed scenario fails the build instead of silently going stale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = join(HERE, '..', 'ops', 'frontier', 'lume');
const RUNNER = join(PACK, 'harness', 'run-frontier.mjs');

const read = (p) => readFileSync(join(PACK, p), 'utf8');

test('frontier pack is complete and self-describing', () => {
  assert.ok(existsSync(RUNNER), 'runner exists');
  assert.ok(existsSync(join(PACK, 'harness', 'reference-proxy.mjs')));
  assert.ok(existsSync(join(PACK, 'README.md')));
  const scenarios = readdirSync(join(PACK, 'scenarios')).filter((f) => f.endsWith('.json'));
  assert.ok(scenarios.length >= 5, 'all five risk classes present');
});

test('frontier-lifecycle record conforms to the governance contract shape', () => {
  const rec = JSON.parse(read('record/frontier-lifecycle.record.json'));
  assert.equal(rec.schema, 'frontier-lifecycle/1.0');
  assert.equal(rec.lifecycle, 'frontier');
  assert.equal(rec.self_promoted, false);
  assert.equal(rec.carries_authority, false);
  assert.ok(rec.canonical_owner_refs.includes('Aftergraph/Lume'));
  assert.ok(Array.isArray(rec.claims) && rec.claims.length > 0);
  assert.ok(Array.isArray(rec.non_claims) && rec.non_claims.length > 0);
  assert.ok(Array.isArray(rec.evidence_refs) && rec.evidence_refs.length > 0);
  assert.ok(Array.isArray(rec.verifier_refs) && rec.verifier_refs.length > 0);
});

test('every scenario is well-formed and names a known risk class', () => {
  const classes = new Set(['secret-leak', 'sse-integrity', 'cors-boundary', 'upstream-failure', 'content-type']);
  const files = readdirSync(join(PACK, 'scenarios')).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const s = JSON.parse(read(join('scenarios', f)));
    assert.ok(classes.has(s.risk_class), `${f}: unknown risk class ${s.risk_class}`);
    assert.equal(s.id, f.replace(/\.json$/, ''), `${f}: id must match filename`);
    assert.ok(s.probe && s.probe.path && s.probe.method, `${f}: probe incomplete`);
    assert.ok(s.upstream_replay && Number.isInteger(s.upstream_replay.status), `${f}: replay incomplete`);
    assert.ok(s.expect && typeof s.expect === 'object', `${f}: expectations incomplete`);
  }
});

test('harness passes the compliant reference proxy (self-test)', () => {
  const out = execFileSync('node', [RUNNER, '--self-test'], { encoding: 'utf8' });
  const doc = JSON.parse(out.slice(out.indexOf('{')));
  assert.equal(doc.counts.PASS, doc.results.length);
  assert.equal(doc.counts.FAIL, undefined);
  assert.equal(doc.counts.INCONCLUSIVE, undefined);
});

test('harness detects every sabotage class (fail-closed)', () => {
  const classes = ['secret-leak', 'sse-integrity', 'cors-boundary', 'upstream-failure', 'content-type'];
  for (const cls of classes) {
    let out = '';
    let code = 0;
    try {
      out = execFileSync('node', [RUNNER, '--self-test', `--sabotage=${cls}`], { encoding: 'utf8' });
    } catch (e) {
      code = e.status;
      out = (e.stdout || '') + (e.stderr || '');
    }
    const doc = JSON.parse(out.slice(out.indexOf('{')));
    const hit = doc.results.find((r) => r.id === cls);
    assert.ok(hit, `${cls}: scenario ran`);
    assert.equal(hit.verdict, 'FAIL', `${cls}: sabotage must be detected`);
    assert.equal(code, 1, `${cls}: run must exit non-zero`);
  }
});

test('runner refuses non-loopback targets', () => {
  let code = 0;
  try {
    execFileSync('node', [RUNNER, '--target', 'http://0.0.0.0:8080'], { encoding: 'utf8' });
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 2, 'non-loopback target must be refused with exit 2');
});

test('scenarios contain no real credential-shaped fixtures', () => {
  const files = readdirSync(join(PACK, 'scenarios')).filter((f) => f.endsWith('.json'));
  for (const f of files) {
    const raw = read(join('scenarios', f)).toLowerCase();
    assert.ok(!raw.includes('ghp_'), `${f}: no GitHub token pattern`);
    assert.ok(!/\bsk-[a-z0-9]{20,}\b/.test(raw), `${f}: no realistic secret pattern`);
    if (raw.includes('sk-')) {
      assert.ok(raw.includes('sk-live-9f1e2'), `${f}: dummy fixture marker only`);
    }
  }
});
