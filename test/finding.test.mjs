import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clear, list } from '../lib/audit.js';
import { createFinding, transition, setAiConfidence } from '../lib/finding.js';

function base(over = {}) {
  return {
    ruleId: 'no-eval-with-dynamic-input',
    file: 'a.js',
    line: 1,
    evidence: 'eval(x)',
    aiConfidence: 0.5,
    targetSha: 'a'.repeat(40),
    actor: 'human',
    ...over,
  };
}

test('finding: create starts at HYPOTHESIS', () => {
  clear();
  const f = createFinding(base());
  assert.equal(f.verification_state, 'HYPOTHESIS');
  assert.equal(f.aiConfidence, 0.5);
});

test('finding: full lifecycle HYPOTHESIS->VERIFYING->CONFIRMED', () => {
  clear();
  const f = createFinding(base());
  transition(f, 'VERIFYING', { actor: 'human' });
  assert.equal(f.verification_state, 'VERIFYING');
  transition(f, 'CONFIRMED', { actor: 'human' });
  assert.equal(f.verification_state, 'CONFIRMED');
});

test('finding: full lifecycle to NOT_REPRODUCED', () => {
  clear();
  const f = createFinding(base());
  transition(f, 'VERIFYING', { actor: 'human' });
  transition(f, 'NOT_REPRODUCED', { actor: 'human' });
  assert.equal(f.verification_state, 'NOT_REPRODUCED');
});

test('finding: full lifecycle to INDETERMINATE', () => {
  clear();
  const f = createFinding(base());
  transition(f, 'VERIFYING', { actor: 'human' });
  transition(f, 'INDETERMINATE', { actor: 'human' });
  assert.equal(f.verification_state, 'INDETERMINATE');
});

test('finding: full lifecycle to DISMISSED from HYPOTHESIS (reason required)', () => {
  clear();
  const f = createFinding(base());
  transition(f, 'DISMISSED', { actor: 'human', reason: 'false positive' });
  assert.equal(f.verification_state, 'DISMISSED');
});

test('finding: full lifecycle to DISMISSED from VERIFYING', () => {
  clear();
  const f = createFinding(base());
  transition(f, 'VERIFYING', { actor: 'human' });
  transition(f, 'DISMISSED', { actor: 'human', reason: 'out of scope' });
  assert.equal(f.verification_state, 'DISMISSED');
});

test('finding: DISMISSED without reason throws', () => {
  clear();
  const f = createFinding(base());
  assert.throws(() => transition(f, 'DISMISSED', { actor: 'human' }), Error);
  assert.equal(f.verification_state, 'HYPOTHESIS');
});

test('finding: illegal transitions throw (skip VERIFYING, exit terminal)', () => {
  clear();
  const f = createFinding(base());
  assert.throws(() => transition(f, 'CONFIRMED', { actor: 'human' }), /illegal transition/);
  assert.equal(f.verification_state, 'HYPOTHESIS');
  transition(f, 'VERIFYING', { actor: 'human' });
  assert.throws(() => transition(f, 'HYPOTHESIS', { actor: 'human' }), /illegal transition/);
  transition(f, 'CONFIRMED', { actor: 'human' });
  assert.throws(() => transition(f, 'DISMISSED', { actor: 'human', reason: 'x' }), /terminal/);
  assert.throws(() => transition(f, 'VERIFYING', { actor: 'human' }), /terminal/);
  assert.equal(f.verification_state, 'CONFIRMED');
});

test('finding: actor ai attempting any transition throws and leaves state untouched', () => {
  clear();
  const f = createFinding(base());
  assert.throws(() => transition(f, 'VERIFYING', { actor: 'ai' }), /'ai'/);
  assert.equal(f.verification_state, 'HYPOTHESIS');
  transition(f, 'VERIFYING', { actor: 'human' });
  assert.throws(() => transition(f, 'CONFIRMED', { actor: 'ai' }), /'ai'/);
  assert.equal(f.verification_state, 'VERIFYING');
  assert.throws(() => transition(f, 'DISMISSED', { actor: 'ai', reason: 'r' }), /'ai'/);
  assert.equal(f.verification_state, 'VERIFYING');
});

test('finding: setAiConfidence never changes verification_state (ai allowed)', () => {
  clear();
  const f = createFinding(base({ aiConfidence: 0.2 }));
  setAiConfidence(f, 0.9, 'ai');
  assert.equal(f.aiConfidence, 0.9);
  assert.equal(f.verification_state, 'HYPOTHESIS');
  transition(f, 'VERIFYING', { actor: 'human' });
  setAiConfidence(f, 0.1, 'human');
  assert.equal(f.aiConfidence, 0.1);
  assert.equal(f.verification_state, 'VERIFYING');
});

test('finding: setAiConfidence rejects out-of-range values', () => {
  clear();
  const f = createFinding(base());
  assert.throws(() => setAiConfidence(f, 2, 'human'), Error);
  assert.throws(() => setAiConfidence(f, -0.1, 'human'), Error);
  assert.equal(f.aiConfidence, 0.5);
});

test('finding: audit log records every mutation in order with monotonic seq', () => {
  clear();
  const f = createFinding(base());
  transition(f, 'VERIFYING', { actor: 'human' });
  setAiConfidence(f, 0.8, 'ai');
  transition(f, 'CONFIRMED', { actor: 'human', reason: 'verified' });
  const events = list();
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((e) => e.type), ['create', 'transition', 'confidence', 'transition']);
  assert.deepEqual(events.map((e) => e.findingId), [f.id, f.id, f.id, f.id]);
  for (let i = 0; i < events.length; i++) {
    assert.equal(events[i].seq, i + 1);
    assert.ok(events[i].ts);
  }
  assert.equal(events[0].from, null);
  assert.equal(events[0].to, 'HYPOTHESIS');
  assert.equal(events[1].from, 'HYPOTHESIS');
  assert.equal(events[1].to, 'VERIFYING');
  assert.equal(events[2].from, 0.5);
  assert.equal(events[2].to, 0.8);
  assert.equal(events[2].actor, 'ai');
  assert.equal(events[3].from, 'VERIFYING');
  assert.equal(events[3].to, 'CONFIRMED');
});
