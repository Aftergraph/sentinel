import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, append, partition, fingerprint, keyOf } from '../lib/memory.js';
import { computeVerdict, toSarif, formatHuman } from '../lib/review.js';

const RULE_IDS = [
  'no-unauthenticated-api-endpoints',
  'no-secrets-in-cicd-config',
  'require-transaction-rollback-on-failure',
  'no-unindexed-schema-migration-on-large-tables',
  'no-n-plus-one-queries-in-api-resolvers',
  'require-dataloader-or-eager-load-for-nested-fetches',
];

test('memory: resolve-then-rerun silences matching finding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-mem-'));
  const memPath = join(dir, 'resolutions.jsonl');
  try {
    const finding = {
      ruleId: 'no-secrets-in-cicd-config',
      file: '.github/workflows/ci.yml',
      line: 42,
      evidence: 'API_KEY=abc123'
    };
    append({ ...finding, resolvingHeadSha: 'aaa111', reason: 'false positive' }, memPath);
    const resolutions = load(memPath);
    const { blocking, silenced } = partition([finding], resolutions);
    assert.equal(blocking.length, 0, 'finding should be silenced');
    assert.equal(silenced.length, 1, 'one silenced finding');
    assert.equal(silenced[0].ruleId, finding.ruleId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('memory: silenced findings excluded from verdict count, verdict flips to SHIP', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-verdict-'));
  const memPath = join(dir, 'resolutions.jsonl');
  try {
    const f1 = { ruleId: 'no-secrets-in-cicd-config', file: 'a.yml', line: 1, evidence: 'SECRET=x' };
    const f2 = { ruleId: 'no-unauthenticated-api-endpoints', file: 'b.js', line: 5, evidence: 'app.get("/open")' };
    append({ ...f1, resolvingHeadSha: 'bbb222' }, memPath);
    const resolutions = load(memPath);
    const result = computeVerdict([f1, f2], resolutions, {
      headSha: 'ccc333',
      baseSha: 'ddd444',
      rulePackVersion: '1.0.0'
    });
    assert.equal(result.verdict, 'DO_NOT_SHIP', 'still blocking because f2 is open');
    assert.equal(result.blocking.length, 1);
    assert.equal(result.silenced.length, 1);

    // Now silence f2 too
    append({ ...f2, resolvingHeadSha: 'eee555' }, memPath);
    const resolutions2 = load(memPath);
    const result2 = computeVerdict([f1, f2], resolutions2, {
      headSha: 'fff666',
      baseSha: 'ggg777',
      rulePackVersion: '1.0.0'
    });
    assert.equal(result2.verdict, 'SHIP', 'all silenced → SHIP');
    assert.equal(result2.blocking.length, 0);
    assert.equal(result2.silenced.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SARIF: structure validity (runs/results/ruleId/locations)', () => {
  const findings = [
    { ruleId: 'no-secrets-in-cicd-config', file: 'ci.yml', line: 10, evidence: 'TOKEN=leak' },
    { ruleId: 'no-unauthenticated-api-endpoints', file: 'routes.js', line: 20, evidence: 'app.delete("/purge")' }
  ];
  const result = computeVerdict(findings, new Set(), {
    headSha: 'abc123def456abc123def456abc123def456abcd',
    baseSha: '111222333444555666777888999000aaabbbcccd',
    rulePackVersion: '1.0.0'
  });
  const sarifWrap = toSarif(result);

  // Verdict envelope
  assert.ok(sarifWrap.verdict, 'verdict envelope present');
  assert.equal(sarifWrap.verdict.verdict, 'DO_NOT_SHIP');
  assert.equal(sarifWrap.verdict.headSha, result.headSha);
  assert.equal(sarifWrap.verdict.baseSha, result.baseSha);
  assert.equal(sarifWrap.verdict.rulePackVersion, '1.0.0');

  // SARIF structure
  const sarif = sarifWrap.sarif;
  assert.equal(sarif.version, '2.1.0');
  assert.ok(Array.isArray(sarif.runs), 'runs is array');
  assert.equal(sarif.runs.length, 1);
  const run = sarif.runs[0];
  assert.ok(run.tool && run.tool.driver, 'tool.driver present');
  assert.equal(run.tool.driver.name, 'sentinel');
  assert.ok(Array.isArray(run.results), 'results is array');
  assert.equal(run.results.length, 2);

  for (const r of run.results) {
    assert.ok(r.ruleId, 'ruleId present');
    assert.ok(['error', 'warning', 'note'].includes(r.level), `valid level: ${r.level}`);
    assert.ok(r.locations && r.locations.length >= 1, 'locations present');
    const loc = r.locations[0].physicalLocation;
    assert.ok(loc.artifactLocation && loc.artifactLocation.uri, 'artifactLocation.uri present');
    assert.ok(loc.region && typeof loc.region.startLine === 'number', 'startLine is number');
  }
});

test('formatHuman: shows silenced section when present', () => {
  const findings = [
    { ruleId: 'no-secrets-in-cicd-config', file: 'x.yml', line: 1, evidence: 'e1' }
  ];
  const silenced = { ruleId: 'no-unauthenticated-api-endpoints', file: 'y.js', line: 2, evidence: 'e2' };
  const result = {
    verdict: 'DO_NOT_SHIP',
    headSha: 'aaa',
    baseSha: 'bbb',
    rulePackVersion: '1.0.0',
    blocking: findings,
    silenced: [silenced],
    checksPassed: 6
  };
  const out = formatHuman(result);
  assert.ok(out.includes('DO NOT SHIP'), 'shows verdict');
  assert.ok(out.includes('Silenced'), 'shows silenced section');
  assert.ok(out.includes('y.js:2'), 'shows silenced file');
});
