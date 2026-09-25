import test from 'node:test';
import assert from 'node:assert/strict';
import { runProbe } from '../scripts/study015-probe.mjs';

test('STUDY-015 probe executes exact-SHA independent verification path', async () => {
  const receipt = await runProbe();
  assert.equal(receipt.schema, 'study015.probe/1.0');
  assert.equal(receipt.component, 'sentinel');
  assert.equal(receipt.network_used, false);
  assert.match(receipt.source_head, /^[a-f0-9]{40}$/);
  assert.ok(Object.values(receipt.mechanisms).every(Boolean));
  assert.equal(receipt.observations.verification_state, 'CONFIRMED');
  assert.equal(receipt.observations.evidence_count, 2);
  assert.equal(receipt.observations.mismatch_error_code, 'INVALID_VERIFICATION');
  assert.equal(receipt.observations.mismatch_command_executed, false);
  assert.equal(receipt.observations.zero_evidence_blocked, true);
});
