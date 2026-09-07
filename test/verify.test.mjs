import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clear, list } from '../lib/audit.js';
import { createFinding } from '../lib/finding.js';
import { sealEvidence } from '../lib/evidence.js';
import { CHECK_TYPES, planChecks, createRun, startRun, completeRun } from '../lib/verify.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function mkFinding(over = {}) {
  return createFinding({
    ruleId: 'no-eval-with-dynamic-input',
    file: 'a.js',
    line: 1,
    evidence: 'eval(x)',
    targetSha: SHA_A,
    ...over,
  });
}

function passResults(run) {
  return Object.fromEntries(run.checks.map((c) => [c.type, 'pass']));
}

function sealFor(run, over = {}) {
  return sealEvidence({
    runId: run.id,
    targetSha: SHA_A,
    type: 'check',
    command: 'npm test',
    exitCode: 0,
    result: 'pass',
    artifacts: [],
    ...over,
  });
}

test('verify: closed check set has the 8 expected types', () => {
  assert.deepEqual(CHECK_TYPES, [
    'BUILD', 'TEST', 'TYPECHECK', 'LINT',
    'STATIC_ANALYSIS', 'SECRET_SCAN', 'CONTRACT_TEST', 'POLICY_CHECK',
  ]);
});

test('verify: planner table is deterministic (same finding -> same checks)', () => {
  clear();
  const f = mkFinding();
  const a = planChecks(f);
  const b = planChecks(JSON.parse(JSON.stringify({ ruleId: f.ruleId, severity: f.severity })));
  assert.deepEqual(a, b);
  assert.deepEqual(planChecks(f), a);
  // Every planned check comes from the closed set.
  assert.ok(a.length > 0);
  for (const t of a) assert.ok(CHECK_TYPES.includes(t), `open check type ${t}`);
});

test('verify: planner maps severity/ruleId (security vs style differ)', () => {
  clear();
  const sec = planChecks(mkFinding({ ruleId: 'no-eval-with-dynamic-input' }));
  const style = planChecks(mkFinding({ ruleId: 'no-var-instead-of-let-const' }));
  assert.ok(sec.includes('SECRET_SCAN') || sec.includes('STATIC_ANALYSIS'));
  assert.ok(style.includes('LINT'));
  assert.notDeepEqual(sec, style);
});

test('verify: policy pin and validation', () => {
  clear();
  const f = mkFinding();
  assert.deepEqual(planChecks(f, { checks: ['TEST', 'BUILD'] }), ['BUILD', 'TEST']);
  const withExtra = planChecks(f, { extraChecks: ['BUILD'] });
  assert.ok(withExtra.includes('BUILD'));
  assert.throws(() => planChecks(f, { checks: ['LLM_JUDGE'] }), /unknown check type/);
  assert.throws(() => planChecks({}, null), /ruleId/);
});

test('verify: run lifecycle PENDING->RUNNING->PASS on all-pass', () => {
  clear();
  const f = mkFinding();
  const run = createRun(f);
  assert.equal(run.status, 'PENDING');
  assert.equal(run.findingId, f.id);
  assert.equal(run.targetSha, SHA_A);
  assert.deepEqual(run.checks.map((c) => c.status), run.checks.map(() => 'PENDING'));
  startRun(run);
  assert.equal(run.status, 'RUNNING');
  const ev = sealFor(run);
  const out = completeRun(f, run, passResults(run), [ev]);
  assert.equal(out, run);
  assert.equal(run.status, 'PASS');
  assert.equal(f.verification_state, 'CONFIRMED');
  assert.deepEqual(f.evidenceRefs, [ev.id]);
});

test('verify: missing required check result throws BLOCKED and mutates nothing', () => {
  clear();
  const f = mkFinding();
  const run = createRun(f);
  startRun(run);
  const results = passResults(run);
  delete results[run.checks[0].type];
  let err = null;
  try {
    completeRun(f, run, results, []);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected BLOCKED throw');
  assert.match(err.message, /BLOCKED/);
  assert.equal(err.code, 'BLOCKED');
  assert.equal(run.status, 'RUNNING');
  assert.equal(f.verification_state, 'HYPOTHESIS');
});

test('verify: SHA-mismatch evidence rejected with INVALID_VERIFICATION', () => {
  clear();
  const f = mkFinding();
  const run = createRun(f);
  startRun(run);
  const bad = sealFor(run, { targetSha: SHA_B });
  let err = null;
  try {
    completeRun(f, run, passResults(run), [bad]);
  } catch (e) {
    err = e;
  }
  assert.ok(err, 'expected INVALID_VERIFICATION throw');
  assert.match(err.message, /INVALID_VERIFICATION/);
  assert.equal(err.code, 'INVALID_VERIFICATION');
  assert.equal(run.status, 'RUNNING');
  assert.equal(f.verification_state, 'HYPOTHESIS');
  assert.equal(f.evidenceRefs, undefined);
});

test('verify: refuting check transitions finding to NOT_REPRODUCED, run FAIL', () => {
  clear();
  const f = mkFinding();
  const run = createRun(f);
  startRun(run);
  const results = passResults(run);
  results[run.checks[0].type] = 'refute';
  completeRun(f, run, results, [sealFor(run)]);
  assert.equal(f.verification_state, 'NOT_REPRODUCED');
  assert.equal(run.status, 'FAIL');
  assert.equal(run.outcome, 'NOT_REPRODUCED');
});

test('verify: plain failure stays VERIFYING, run FAIL', () => {
  clear();
  const f = mkFinding();
  const run = createRun(f);
  startRun(run);
  const results = passResults(run);
  results[run.checks[0].type] = 'fail';
  completeRun(f, run, results, []);
  assert.equal(f.verification_state, 'VERIFYING');
  assert.equal(run.status, 'FAIL');
});

test('verify: spec-literal completeRun(run, results, evidenceItems) works via binding', () => {
  clear();
  const f = mkFinding();
  const run = createRun(f);
  startRun(run);
  completeRun(run, passResults(run), [sealFor(run)]);
  assert.equal(run.status, 'PASS');
  assert.equal(f.verification_state, 'CONFIRMED');
});

test('verify: results accept array form and outcome synonyms', () => {
  clear();
  const f = mkFinding();
  const run = createRun(f);
  startRun(run);
  const arr = run.checks.map((c) => ({ type: c.type, outcome: 'PASSED' }));
  completeRun(f, run, arr, []);
  assert.equal(run.status, 'PASS');
  assert.equal(f.verification_state, 'CONFIRMED');
});

test('verify: audit trail records plan/start/complete plus transition and evidence', () => {
  clear();
  const f = mkFinding();
  const run = createRun(f);
  startRun(run);
  const ev = sealFor(run);
  completeRun(f, run, passResults(run), [ev]);
  const types = list().map((e) => e.type);
  for (const t of ['create', 'verify_plan', 'verify_start', 'transition', 'evidence', 'verify_complete']) {
    assert.ok(types.includes(t), `missing audit event ${t}`);
  }
  const events = list();
  for (let i = 1; i < events.length; i++) assert.ok(events[i].seq > events[i - 1].seq);
  const done = events.find((e) => e.type === 'verify_complete');
  assert.equal(done.findingId, f.id);
  assert.equal(done.to, 'PASS');
  assert.equal(done.reason, 'CONFIRMED');
});
