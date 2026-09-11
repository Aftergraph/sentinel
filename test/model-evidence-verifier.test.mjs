import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyCapturedCampaign } from '../lib/model-evidence-verifier.js';

function passingTrial() {
  return {
    results: [
      { id: 'instruction', passed: true, outputText: 'AFTERGRAPH_OK', toolCalls: [] },
      { id: 'code', passed: true, outputText: '14', toolCalls: [] },
      { id: 'json', passed: true, outputText: '{"status":"ok","count":3}', toolCalls: [] },
      { id: 'constraints', passed: true, outputText: 'ALPHA BETA GAMMA.', toolCalls: [] },
      { id: 'tool', passed: true, outputText: '', toolCalls: [{ function: { name: 'lookup', arguments: '{"repo":"Aftergraph/model-registry","issue":19}' } }] },
    ],
  };
}

function document() {
  return {
    campaign: 'ling-openrouter-qualification-001',
    model: 'inclusionai/ling-3.0-flash-vl:free',
    trials: [passingTrial()],
  };
}

test('independently re-scores all five tasks and PASSes matching evidence', () => {
  const result = verifyCapturedCampaign(document());
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.score_mismatches, 0);
  assert.equal(result.aggregate_pass_rate, 1);
  assert.match(result.attestation_sha256, /^[0-9a-f]{64}$/);
});

test('FAILs when runner pass claim disagrees with independent score', () => {
  const input = document();
  input.trials[0].results[0].outputText = 'not exact';
  const result = verifyCapturedCampaign(input);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.score_mismatches, 1);
  assert.equal(result.rescored[0].runner_passed, true);
  assert.equal(result.rescored[0].independently_passed, false);
});

test('FAILs closed on malformed tool arguments instead of trusting runner claim', () => {
  const input = document();
  input.trials[0].results[4].toolCalls[0].function.arguments = '{bad json';
  const result = verifyCapturedCampaign(input);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.score_mismatches, 1);
});

test('rejects incomplete or duplicated task sets', () => {
  const input = document();
  input.trials[0].results.pop();
  assert.throws(() => verifyCapturedCampaign(input), /expected five results/);
});
