import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeVerdict,
  toSarif,
  toJson,
  formatHuman,
  loadRules,
  VALID_FORMATS,
} from '../lib/review.js';
import {
  RULE_PACK_VERSION,
  SUPPORTED_PACKS,
  SEVERITY_MAP,
  ruleIdsForPack,
} from '../lib/rulepack.js';

test('rulepack: v1.0.0 locks the original 6, v1.1.0 carries 20', () => {
  assert.equal(ruleIdsForPack('1.0.0').length, 6);
  assert.equal(ruleIdsForPack(RULE_PACK_VERSION).length, 20);
  assert.ok(SUPPORTED_PACKS.includes('1.0.0'));
  assert.ok(SUPPORTED_PACKS.includes(RULE_PACK_VERSION));
  assert.throws(() => ruleIdsForPack('9.9.9'), /Unsupported rule pack/);
});

test('rulepack: every rule id has a severity', () => {
  for (const id of ruleIdsForPack(RULE_PACK_VERSION)) {
    assert.ok(SEVERITY_MAP[id], `missing severity for ${id}`);
  }
});

test('loadRules: pack versions resolve to matching rule counts', async () => {
  const v10 = await loadRules('1.0.0');
  const v11 = await loadRules(RULE_PACK_VERSION);
  assert.equal(v10.length, 6);
  assert.equal(v11.length, 20);
  await assert.rejects(() => loadRules('9.9.9'), /Unsupported rule pack/);
});

test('formats: human, json, sarif are the full contract', () => {
  assert.deepEqual([...VALID_FORMATS].sort(), ['human', 'json', 'sarif']);
});

test('verdict: style findings never block, blocking still flips verdict', () => {
  const style = { ruleId: 'no-var-instead-of-let-const', file: 'a.js', line: 1, evidence: 'var x = 1;' };
  const sec = { ruleId: 'no-eval-with-dynamic-input', file: 'b.js', line: 2, evidence: 'eval(x)' };
  const onlyStyle = computeVerdict([style], new Set(), {
    headSha: 'h', baseSha: 'b', rulePackVersion: RULE_PACK_VERSION,
  });
  assert.equal(onlyStyle.verdict, 'SHIP');
  assert.equal(onlyStyle.blocking.length, 0);
  assert.equal(onlyStyle.nonBlocking.length, 1);

  const withSec = computeVerdict([style, sec], new Set(), {
    headSha: 'h', baseSha: 'b', rulePackVersion: RULE_PACK_VERSION,
  });
  assert.equal(withSec.verdict, 'DO_NOT_SHIP');
  assert.equal(withSec.blocking.length, 1);
  assert.equal(withSec.nonBlocking.length, 1);
});

test('verdict: checksPassed follows the requested pack', () => {
  const r10 = computeVerdict([], new Set(), { headSha: 'h', baseSha: 'b', rulePackVersion: '1.0.0' });
  const r11 = computeVerdict([], new Set(), { headSha: 'h', baseSha: 'b', rulePackVersion: RULE_PACK_VERSION });
  assert.equal(r10.checksPassed, 6);
  assert.equal(r11.checksPassed, 20);
});

test('toJson: Review + Verdict + Findings shape per data-model-v0', () => {
  const result = computeVerdict(
    [{ ruleId: 'no-eval-with-dynamic-input', file: 'b.js', line: 2, evidence: 'eval(x)' }],
    new Set(),
    { headSha: 'HEAD1', baseSha: 'BASE1', rulePackVersion: RULE_PACK_VERSION },
  );
  const json = toJson(result, { repo: 'o/r', prNumber: 42 });
  assert.equal(json.review.status, 'complete');
  assert.equal(json.review.headSha, 'HEAD1');
  assert.equal(json.review.rulePackVersion, RULE_PACK_VERSION);
  assert.equal(json.review.repo, 'o/r');
  assert.equal(json.review.prNumber, 42);
  assert.equal(json.verdict.decision, 'DO_NOT_SHIP');
  assert.equal(json.findings.blocking.length, 1);
  assert.ok(Array.isArray(json.findings.nonBlocking));
  assert.equal(json.checksPassed, 20);
});

test('toSarif: style maps to note, correctness maps to error', () => {
  const result = computeVerdict(
    [
      { ruleId: 'no-var-instead-of-let-const', file: 'a.js', line: 1, evidence: 'var x = 1;' },
      { ruleId: 'require-strict-equality', file: 'c.js', line: 3, evidence: 'a == b' },
    ],
    new Set(),
    { headSha: 'h', baseSha: 'b', rulePackVersion: RULE_PACK_VERSION },
  );
  const wrap = toSarif(result);
  const byId = Object.fromEntries(wrap.sarif.runs[0].results.map((r) => [r.ruleId, r.level]));
  assert.equal(byId['no-var-instead-of-let-const'], 'note');
  assert.equal(byId['require-strict-equality'], 'error');
});

test('formatHuman: advisory section shows, rule-pack line present', () => {
  const result = computeVerdict(
    [{ ruleId: 'no-console-log-in-server-diff', file: 's.js', line: 9, evidence: 'console.log(x)' }],
    new Set(),
    { headSha: 'H', baseSha: 'B', rulePackVersion: RULE_PACK_VERSION },
  );
  const out = formatHuman(result);
  assert.ok(out.includes('SHIP — 0 findings'));
  assert.ok(out.includes('Advisory (non-blocking): 1'));
  assert.ok(out.includes(`rule-pack: ${RULE_PACK_VERSION}`));
});
