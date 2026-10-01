import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GITHUB_EVIDENCE_CONTRACT,
  makeGitHubEvidence,
  verifyGitHubEvidence,
} from '../apps/github/evidence.js';

const KEY = 'sentinel-evidence-test-key';

function base(overrides = {}) {
  return {
    repo: 'Aftergraph/sentinel',
    prNumber: 42,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    installationId: 123,
    rulePackVersion: '1.7.0',
    policyHash: 'policy_0123456789abcdef',
    receiptId: 'c'.repeat(64),
    state: 'REVIEWED',
    workflowEvidence: [],
    evidencePackId: null,
    ...overrides,
  };
}

test('github evidence: deterministic exact-head envelope verifies', () => {
  const a = makeGitHubEvidence(base(), { signingKey: KEY });
  const b = makeGitHubEvidence(base(), { signingKey: KEY });

  assert.equal(a.contract, GITHUB_EVIDENCE_CONTRACT);
  assert.equal(a.evidence_id, b.evidence_id);
  assert.match(a.evidence_id, /^sge_[a-f0-9]{64}$/);
  assert.match(a.signature, /^hmac-sha256:[a-f0-9]{64}$/);
  assert.equal(a.repo, 'Aftergraph/sentinel');
  assert.equal(a.headSha, 'a'.repeat(40));
  assert.deepEqual(verifyGitHubEvidence(a, { signingKey: KEY }), { valid: true });
});

test('github evidence: tampering any authority-binding coordinate invalidates envelope', () => {
  const env = makeGitHubEvidence(base(), { signingKey: KEY });
  const mutations = [
    { ...env, repo: 'Aftergraph/other' },
    { ...env, prNumber: 99 },
    { ...env, headSha: 'd'.repeat(40) },
    { ...env, installationId: 999 },
    { ...env, receiptId: 'e'.repeat(64) },
    { ...env, state: 'WORKFLOWS_VERIFIED' },
  ];
  for (const tampered of mutations) {
    assert.equal(verifyGitHubEvidence(tampered, { signingKey: KEY }).valid, false);
  }
});

test('github evidence: states preserve review/workflow/evidence-pack distinctions', () => {
  const reviewed = makeGitHubEvidence(base(), { signingKey: KEY });
  assert.equal(reviewed.state, 'REVIEWED');

  const workflows = makeGitHubEvidence(base({
    state: 'WORKFLOWS_VERIFIED',
    workflowEvidence: [
      { name: 'Go tests', runId: 10, conclusion: 'success', headSha: 'a'.repeat(40) },
    ],
  }), { signingKey: KEY });
  assert.deepEqual(verifyGitHubEvidence(workflows, { signingKey: KEY }), { valid: true });

  assert.throws(
    () => makeGitHubEvidence(base({ state: 'WORKFLOWS_VERIFIED', workflowEvidence: [] }), { signingKey: KEY }),
    /workflow evidence/i,
  );

  const pack = makeGitHubEvidence(base({
    state: 'VERIFIED_EVIDENCE_PACK',
    workflowEvidence: [
      { name: 'Economic Evidence Pack', runId: 11, conclusion: 'success', headSha: 'a'.repeat(40) },
    ],
    evidencePackId: 'evp_' + 'd'.repeat(64),
  }), { signingKey: KEY });
  assert.deepEqual(verifyGitHubEvidence(pack, { signingKey: KEY }), { valid: true });

  assert.throws(
    () => makeGitHubEvidence(base({
      state: 'VERIFIED_EVIDENCE_PACK',
      workflowEvidence: [
        { name: 'Economic Evidence Pack', runId: 11, conclusion: 'success', headSha: 'a'.repeat(40) },
      ],
      evidencePackId: null,
    }), { signingKey: KEY }),
    /evidence pack/i,
  );
});

test('github evidence: invalid coordinates and authority-like fields fail closed', () => {
  assert.throws(() => makeGitHubEvidence(base({ headSha: 'branch-head' }), { signingKey: KEY }), /headSha/i);
  assert.throws(() => makeGitHubEvidence(base({ state: 'APPROVED' }), { signingKey: KEY }), /state/i);
  assert.throws(
    () => makeGitHubEvidence({ ...base(), merged: true }, { signingKey: KEY }),
    /unknown field.*merged/i,
  );
  assert.throws(
    () => makeGitHubEvidence(base(), { signingKey: '' }),
    /signing key/i,
  );
});

test('github evidence: serialized envelope contains no credential material', () => {
  const env = makeGitHubEvidence(base(), { signingKey: KEY });
  const serialized = JSON.stringify(env);
  assert.doesNotMatch(serialized, /ghs_|private.?key|secret:\/\//i);
  assert.doesNotMatch(serialized, new RegExp(KEY));
});
