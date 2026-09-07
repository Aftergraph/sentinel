import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { clear, list } from '../lib/audit.js';
import { createFinding } from '../lib/finding.js';
import { sealEvidence, attachEvidence } from '../lib/evidence.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function input(over = {}) {
  return {
    runId: 'run-1',
    targetSha: SHA_A,
    type: 'repro',
    command: 'node repro.js',
    exitCode: 0,
    result: 'confirmed',
    artifacts: ['out/log.txt'],
    ...over,
  };
}

function withoutSealedAt(item) {
  const { sealedAt, ...rest } = item;
  return rest;
}

test('evidence: seal is deterministic (same input → same hash/id)', () => {
  const a = sealEvidence(input());
  const b = sealEvidence(input());
  assert.equal(a.outputHash, b.outputHash);
  assert.equal(a.id, b.id);
  assert.deepEqual(withoutSealedAt(a), withoutSealedAt(b));
  assert.match(a.outputHash, /^[0-9a-f]{64}$/);
});

test('evidence: outputHash is sha256 over canonical JSON excluding id/sealedAt', () => {
  const a = sealEvidence(input());
  const { id, sealedAt, outputHash, ...body } = a;
  const sorted = Object.fromEntries(Object.keys(body).sort().map((k) => [k, body[k]]));
  const recomputed = createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
  assert.equal(outputHash, recomputed);
  // Key order of the input must not affect the hash.
  const reordered = sealEvidence({
    artifacts: ['out/log.txt'],
    result: 'confirmed',
    exitCode: 0,
    command: 'node repro.js',
    type: 'repro',
    targetSha: SHA_A,
    runId: 'run-1',
  });
  assert.equal(reordered.outputHash, a.outputHash);
  // Different input → different hash/id.
  assert.notEqual(sealEvidence(input({ exitCode: 1 })).outputHash, a.outputHash);
});

test('evidence: sealed item is frozen', () => {
  const a = sealEvidence(input());
  assert.ok(Object.isFrozen(a));
  assert.ok(Object.isFrozen(a.artifactRefs));
});

test('evidence: tampering with a sealed item throws', () => {
  const a = sealEvidence(input());
  assert.throws(() => {
    a.result = 'tampered';
  }, TypeError);
  assert.throws(() => {
    a.outputHash = '0'.repeat(64);
  }, TypeError);
  assert.throws(() => {
    a.artifactRefs.push('evil.txt');
  }, TypeError);
  assert.equal(a.result, 'confirmed');
});

test('evidence: attach on targetSha mismatch throws INVALID_VERIFICATION', () => {
  clear();
  const finding = createFinding({
    ruleId: 'no-eval-with-dynamic-input',
    file: 'a.js',
    targetSha: SHA_A,
  });
  const evidence = sealEvidence(input({ targetSha: SHA_B }));
  let err = null;
  assert.throws(() => attachEvidence(finding, evidence), /INVALID_VERIFICATION/);
  try {
    attachEvidence(finding, evidence);
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(err.code, 'INVALID_VERIFICATION');
  assert.equal(finding.evidenceRefs, undefined);
});

test('evidence: attach on match links id and records an audit event', () => {
  clear();
  const finding = createFinding({
    ruleId: 'no-eval-with-dynamic-input',
    file: 'a.js',
    targetSha: SHA_A,
  });
  const before = list().length;
  const evidence = sealEvidence(input({ targetSha: SHA_A }));
  const out = attachEvidence(finding, evidence, { actor: 'human' });
  assert.equal(out, finding);
  assert.deepEqual(finding.evidenceRefs, [evidence.id]);
  // Second attach accumulates.
  const evidence2 = sealEvidence(input({ runId: 'run-2', targetSha: SHA_A }));
  attachEvidence(finding, evidence2);
  assert.deepEqual(finding.evidenceRefs, [evidence.id, evidence2.id]);
  const events = list().slice(before);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'evidence');
  assert.equal(events[0].findingId, finding.id);
  assert.equal(events[0].to, evidence.id);
  assert.equal(events[1].to, evidence2.id);
});
