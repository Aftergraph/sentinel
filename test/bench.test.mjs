import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBench } from '../bench/runner.js';
import { renderMarkdown, writeReport } from '../bench/report.js';
import { RULE_PACK_VERSION } from '../lib/rulepack.js';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const CASES = join(dirname(fileURLToPath(import.meta.url)), '..', 'bench', 'cases');

test(`bench: pack ${RULE_PACK_VERSION} scores strict on every shipped case`, async () => {
  const { results, metrics, heldoutResults, heldoutMetrics } = await runBench({ pack: RULE_PACK_VERSION, casesDir: CASES });
  assert.equal(results.length, 26, `expected 26 scored cases, got ${results.length}`);
  const misses = results.filter((r) => !r.hit);
  assert.deepEqual(misses.map((r) => r.case), [], 'strict misses must be encoded, not hidden');
  assert.equal(metrics.recall, 1);
  assert.equal(metrics.precision, 1);
  assert.equal(metrics.fpPerCase, 0);
  // Held-out split: evaluated, reported separately, never in the main score.
  assert.equal(heldoutResults.length, 2, `expected 2 held-out cases, got ${heldoutResults.length}`);
  assert.deepEqual(heldoutResults.map((r) => r.case).sort(), ['clean-structured-clone-negative', 'security-eval-l4-positive']);
  assert.deepEqual(heldoutResults.filter((r) => !r.hit).map((r) => r.case), [], 'held-out misses must be visible, not hidden');
  assert.equal(heldoutMetrics.cases, 2);
});

test('bench: metrics are pure counts with sane edges', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-bench-'));
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'clean.json'), JSON.stringify({
      name: 'clean', diffFile: 'test/fixtures/no-eval-with-dynamic-input/negative.diff', expect: [],
    }));
    const { metrics } = await runBench({ pack: RULE_PACK_VERSION, casesDir: dir });
    assert.equal(metrics.cases, 1);
    assert.equal(metrics.recall, 1);
    assert.equal(metrics.precision, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bench: non-strict cases count recall only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-bench-'));
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'recall.json'), JSON.stringify({
      name: 'recall', diffFile: 'test/fixtures/no-eval-with-dynamic-input/positive.diff',
      expect: ['no-eval-with-dynamic-input'], strict: false, reason: 'demo',
    }));
    const { results } = await runBench({ pack: RULE_PACK_VERSION, casesDir: dir });
    assert.equal(results[0].hit, true);
    assert.equal(results[0].strict, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bench: report writes json + markdown artifacts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-bench-'));
  try {
    const out = join(dir, 'out');
    const summary = await writeReport({ pack: RULE_PACK_VERSION, casesDir: CASES, outDir: out });
    assert.ok(existsSync(join(out, 'results.json')));
    const md = readFileSync(join(out, 'REPORT.md'), 'utf8');
    assert.ok(md.includes('# SentinelBench report'));
    assert.ok(md.includes('recall: 1'));
    const parsed = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'));
    assert.equal(parsed.metrics.cases, summary.metrics.cases);
    assert.ok(renderMarkdown({ pack: RULE_PACK_VERSION, summary }).includes('| case | hit |'));
    assert.ok(renderMarkdown(summary).includes('# SentinelBench report'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bench: CLI exits 0 and refreshes bench/results.json + bench/REPORT.md', () => {
  const repoRoot = join(CASES, '..', '..');
  execFileSync('node', [join(repoRoot, 'bench', 'report.js'), RULE_PACK_VERSION], { encoding: 'utf8' });
  assert.ok(existsSync(join(repoRoot, 'bench', 'results.json')));
  assert.ok(existsSync(join(repoRoot, 'bench', 'REPORT.md')));
});
