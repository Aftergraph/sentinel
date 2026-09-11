import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyCapturedCampaign } from '../lib/model-evidence-verifier.js';

const TASK_CONTRACT_BLOB = 'fbdecac2a3ca85bb53d6b2baf1229cdd74cc5e12';

function passingTrial() {
  return {
    results: [
      { id: 'pq-exact-001', passed: true, outputText: 'AFTERGRAPH-LING-OK', toolCalls: [] },
      { id: 'pq-code-001', passed: true, outputText: '[4, 16]', toolCalls: [] },
      { id: 'pq-json-001', passed: true, outputText: '{"status":"ok","value":42}', toolCalls: [] },
      { id: 'pq-tool-001', passed: true, outputText: '', toolCalls: [{ function: { name: 'lookup_user', arguments: '{"user_id":17}' } }] },
      { id: 'pq-constraints-001', passed: true, outputText: 'ALPHA BETA GAMMA.', toolCalls: [] },
    ],
  };
}

function document() {
  return {
    campaign: 'ling-openrouter-qualification-001',
    model: 'inclusionai/ling-3.0-flash-vl:free',
    task_contract_git_blob_sha: TASK_CONTRACT_BLOB,
    trials: [passingTrial()],
  };
}

test('re-scores the canonical LLM-R&D qualification contract exactly', () => {
  const result = verifyCapturedCampaign(document());
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.score_mismatches, 0);
  assert.equal(result.aggregate_pass_rate, 1);
  assert.equal(result.task_contract_git_blob_sha, TASK_CONTRACT_BLOB);
  assert.match(result.attestation_sha256, /^[0-9a-f]{64}$/);
});

test('rejects evidence bound to a different task contract', () => {
  const input = document();
  input.task_contract_git_blob_sha = '0000000000000000000000000000000000000000';
  assert.throws(() => verifyCapturedCampaign(input), /task contract/);
});

test('FAILs when runner pass claim disagrees with independent exact-text score', () => {
  const input = document();
  input.trials[0].results[0].outputText = 'AFTERGRAPH-LING-OK extra';
  const result = verifyCapturedCampaign(input);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.score_mismatches, 1);
});

test('FAILs closed on malformed tool arguments instead of trusting runner claim', () => {
  const input = document();
  input.trials[0].results[3].toolCalls[0].function.arguments = '{bad json';
  const result = verifyCapturedCampaign(input);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.score_mismatches, 1);
});

test('rejects incomplete or duplicated task sets', () => {
  const input = document();
  input.trials[0].results.pop();
  assert.throws(() => verifyCapturedCampaign(input), /expected five results/);
});

test('CLI writes immutable-style attestation and exits zero on PASS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-model-evidence-'));
  const input = path.join(dir, 'capture.json');
  const output = path.join(dir, 'attestation.json');
  fs.writeFileSync(input, JSON.stringify(document()));
  const result = spawnSync(process.execPath, ['scripts/verify-model-evidence.mjs', input, output], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const attestation = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(attestation.verdict, 'PASS');
  assert.equal(attestation.task_contract_git_blob_sha, TASK_CONTRACT_BLOB);
});
