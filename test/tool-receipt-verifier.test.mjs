import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { verifyToolExecutionReceipt } from '../lib/tool-receipt-verifier.mjs';

const canonical = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object') return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
};

function receipt() {
  const base = {
    schemaVersion: 'aftergraph.tool-receipt/v1',
    invocationId: 'inv-1',
    toolId: 'relay.system.health',
    capability: 'EXECUTION_OBSERVE',
    runtime: 'relay',
    startedAt: '2026-09-30T00:00:00Z',
    finishedAt: '2026-09-30T00:00:01Z',
    outcome: 'success',
    artifactRefs: [],
    evidenceRefs: ['audit://1'],
    credentialMaterialExposed: false,
  };
  return {
    ...base,
    receiptDigest: createHash('sha256').update(canonical(base)).digest('hex'),
  };
}

test('verifies an intact ToolFabric receipt independently', () => {
  const result = verifyToolExecutionReceipt(receipt());
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.independent, true);
  assert.equal(result.authorityGranted, false);
});

test('rejects credential exposure and tampering', () => {
  const exposed = { ...receipt(), credentialMaterialExposed: true };
  assert.equal(verifyToolExecutionReceipt(exposed).status, 'INVALID');

  const tampered = { ...receipt(), outcome: 'error' };
  const result = verifyToolExecutionReceipt(tampered);
  assert.equal(result.status, 'INVALID');
  assert.ok(result.reasons.includes('receipt_digest_mismatch'));
});
