import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOLS, dispatch, handleMessage, createFramer, frame,
} from '../mcp/sentinel-mcp.js';
import { RULE_PACK_VERSION } from '../lib/rulepack.js';
import { planChecks } from '../lib/verify.js';
import { parsePolicy } from '../lib/policy.js';
import { list as auditList, clear as auditClear } from '../lib/audit.js';

const HAPPY_POLICY = `apiVersion: sentinel.aftergraph/v1
kind: VerificationPolicy
metadata:
  name: web-strict
spec:
  scope:
    repo: acme/web
    paths:
      - "src/**"
  required:
    - sast
    - dast
  blocking_severity:
    - security
    - reliability
  approvals:
    required:
      - alice
`;

function bodyOf(out) {
  return JSON.parse(out.content[0].text);
}

test('mcp-extended: tools/list exposes the 3 new judge tools, still read-only', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 101, method: 'tools/list' });
  const names = res.result.tools.map((t) => t.name);
  for (const n of ['sentinel_finding_lifecycle', 'sentinel_verify_plan', 'sentinel_policy_evaluate']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  assert.ok(!names.some((n) => /fix|approve|push|write|runLocal/i.test(n)), 'no write/exec tools');
  assert.ok(TOOLS.length >= 8, `expected >=8 tools, got ${TOOLS.length}`);
});

test('mcp-extended: finding_lifecycle list-states happy path (read-only)', async () => {
  auditClear();
  const before = auditList().length;
  const finding = { ruleId: 'no-eval-with-dynamic-input', verification_state: 'HYPOTHESIS' };
  const snap = structuredClone(finding);
  const out = await dispatch('sentinel_finding_lifecycle', { finding, action: 'list-states' });
  assert.equal(out.isError, undefined);
  const body = bodyOf(out);
  assert.deepEqual(body.states, ['HYPOTHESIS', 'VERIFYING', 'CONFIRMED', 'NOT_REPRODUCED', 'INDETERMINATE', 'DISMISSED']);
  assert.ok(body.terminalStates.includes('CONFIRMED'));
  assert.ok(body.terminalStates.includes('DISMISSED'));
  assert.deepEqual(body.allowedNext, ['VERIFYING', 'DISMISSED']);
  assert.equal(body.currentState, 'HYPOTHESIS');
  assert.equal(body.rulePackVersion, RULE_PACK_VERSION);
  assert.ok('policyVersion' in body);
  // No mutation of the finding, no audit side effects.
  assert.deepEqual(finding, snap);
  assert.equal(auditList().length, before);
});

test('mcp-extended: finding_lifecycle validate-transition legal', async () => {
  const finding = { ruleId: 'x', verification_state: 'HYPOTHESIS' };
  const snap = structuredClone(finding);
  const out = await dispatch('sentinel_finding_lifecycle', {
    finding, action: 'validate-transition', to: 'VERIFYING',
  });
  const body = bodyOf(out);
  assert.equal(body.legal, true);
  assert.equal(body.from, 'HYPOTHESIS');
  assert.equal(body.to, 'VERIFYING');
  assert.equal(body.rulePackVersion, RULE_PACK_VERSION);
  assert.deepEqual(finding, snap, 'tool must not mutate the finding');
});

test('mcp-extended: finding_lifecycle validate-transition illegal cases', async () => {
  // Skip VERIFYING: HYPOTHESIS -> CONFIRMED is illegal.
  const skip = bodyOf(await dispatch('sentinel_finding_lifecycle', {
    finding: { verification_state: 'HYPOTHESIS' }, action: 'validate-transition', to: 'CONFIRMED',
  }));
  assert.equal(skip.legal, false);
  assert.match(skip.explanation, /illegal transition/);

  // Terminal accepts nothing.
  const term = bodyOf(await dispatch('sentinel_finding_lifecycle', {
    finding: { verification_state: 'CONFIRMED' }, action: 'validate-transition', to: 'VERIFYING',
  }));
  assert.equal(term.legal, false);
  assert.match(term.explanation, /terminal/);

  // DISMISSED without reason is illegal; with reason is legal.
  const noReason = bodyOf(await dispatch('sentinel_finding_lifecycle', {
    finding: { verification_state: 'HYPOTHESIS' }, action: 'validate-transition', to: 'DISMISSED',
  }));
  assert.equal(noReason.legal, false);
  assert.match(noReason.explanation, /reason/);
  const withReason = bodyOf(await dispatch('sentinel_finding_lifecycle', {
    finding: { verification_state: 'HYPOTHESIS' }, action: 'validate-transition', to: 'DISMISSED', reason: 'false positive',
  }));
  assert.equal(withReason.legal, true);
});

test('mcp-extended: verify_plan happy path matches lib table', async () => {
  auditClear();
  const before = auditList().length;
  const out = await dispatch('sentinel_verify_plan', { ruleId: 'no-eval-with-dynamic-input' });
  const body = bodyOf(out);
  const expected = planChecks({ ruleId: 'no-eval-with-dynamic-input' }, null);
  assert.deepEqual(body.checks, expected);
  assert.equal(body.ruleId, 'no-eval-with-dynamic-input');
  assert.equal(body.rulePackVersion, RULE_PACK_VERSION);
  assert.ok('policyVersion' in body);
  assert.ok(body.checks.length > 0);
  // Style rule plans differently (lib severity table).
  const style = bodyOf(await dispatch('sentinel_verify_plan', { ruleId: 'no-var-instead-of-let-const' }));
  assert.deepEqual(style.checks, planChecks({ ruleId: 'no-var-instead-of-let-const' }, null));
  assert.ok(style.checks.includes('LINT'));
  assert.notDeepEqual(body.checks, style.checks);
  // Pure planning: no audit events.
  assert.equal(auditList().length, before);
});

test('mcp-extended: policy_evaluate happy path (SHIP)', async () => {
  const out = await dispatch('sentinel_policy_evaluate', {
    policyText: HAPPY_POLICY,
    repo: 'acme/web',
    path: 'src/app/main.js',
    findings: [],
    checks: { sast: 'pass', dast: 'pass' },
    headSha: 'abc123',
  });
  assert.equal(out.isError, undefined);
  const body = bodyOf(out);
  assert.equal(body.verdict, 'SHIP');
  assert.equal(body.allowed, true);
  assert.equal(body.rulePackVersion, RULE_PACK_VERSION);
  assert.equal(body.policyVersion, parsePolicy(HAPPY_POLICY).policyVersion);
});

test('mcp-extended: policy_evaluate blocking finding -> DO_NOT_SHIP', async () => {
  const out = await dispatch('sentinel_policy_evaluate', {
    policyText: HAPPY_POLICY,
    repo: 'acme/web',
    path: 'src/app/main.js',
    findings: [{ ruleId: 'no-eval-with-dynamic-input', file: 'src/app.js', line: 2, evidence: 'eval(x)' }],
    checks: { sast: 'pass', dast: 'pass' },
    headSha: 'abc123',
  });
  const body = bodyOf(out);
  assert.equal(body.verdict, 'DO_NOT_SHIP');
  assert.equal(body.allowed, false);
  assert.ok(body.reasons.some((r) => r.includes('src/app.js')));
  assert.equal(body.rulePackVersion, RULE_PACK_VERSION);
  assert.ok(typeof body.policyVersion === 'string' && body.policyVersion.startsWith('web-strict@'));
});

test('mcp-extended: policy_evaluate malformed returns isError, never throws', async () => {
  // Garbage YAML: dispatch must resolve (not reject) with isError true.
  const bad = await dispatch('sentinel_policy_evaluate', {
    policyText: 'just some words\n: : :',
    repo: 'acme/web',
    path: 'src/app/main.js',
    findings: [],
    checks: {},
    headSha: 'abc123',
  });
  assert.equal(bad.isError, true);
  assert.match(JSON.parse(bad.content[0].text).error, /Invalid policy|policy/i);

  // Wrong apiVersion.
  const wrongVer = await dispatch('sentinel_policy_evaluate', {
    policyText: HAPPY_POLICY.replace('sentinel.aftergraph/v1', 'sentinel.aftergraph/v9'),
    repo: 'acme/web',
    path: 'src/app/main.js',
    findings: [],
    checks: {},
    headSha: 'abc123',
  });
  assert.equal(wrongVer.isError, true);

  // Scope mismatch (no matching policy) is also isError, not a throw.
  const mismatch = await dispatch('sentinel_policy_evaluate', {
    policyText: HAPPY_POLICY,
    repo: 'acme/unknown',
    path: 'src/app/main.js',
    findings: [],
    checks: { sast: 'pass', dast: 'pass' },
    headSha: 'abc123',
  });
  assert.equal(mismatch.isError, true);

  // Same guarantee through the JSON-RPC layer.
  const viaRpc = await handleMessage({
    jsonrpc: '2.0', id: 102, method: 'tools/call',
    params: { name: 'sentinel_policy_evaluate', arguments: { policyText: 'nope', repo: 'acme/web', path: 'x' } },
  });
  assert.equal(viaRpc.result.isError, true);
});

test('mcp-extended: framing multi-message split still works', () => {
  const framer = createFramer();
  const a = { jsonrpc: '2.0', id: 201, method: 'tools/list' };
  const b = {
    jsonrpc: '2.0', id: 202, method: 'tools/call',
    params: { name: 'sentinel_verify_plan', arguments: { ruleId: 'no-eval-with-dynamic-input' } },
  };
  const both = Buffer.concat([frame(a), frame(b)]);
  assert.equal(framer.push(both).length, 2);
  const framer2 = createFramer();
  const half = frame(a);
  assert.equal(framer2.push(half.subarray(0, 10)).length, 0);
  assert.equal(framer2.push(half.subarray(10)).length, 1);
});

test('mcp-extended: unknown tool keeps the existing error path', async () => {
  const res = await handleMessage({
    jsonrpc: '2.0', id: 103, method: 'tools/call',
    params: { name: 'sentinel_nope', arguments: {} },
  });
  assert.equal(res.error.code, -32602);
  await assert.rejects(() => dispatch('sentinel_nope', {}), /Unknown tool/);
});
