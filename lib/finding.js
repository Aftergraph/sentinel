// Finding lifecycle — ENGINE S1.
//
// A finding starts at verification_state HYPOTHESIS and moves through
// VERIFYING to a terminal state. State machine:
//
//   HYPOTHESIS -> VERIFYING -> CONFIRMED | NOT_REPRODUCED | INDETERMINATE
//   <any non-terminal> -> DISMISSED (reason required)
//
// Terminals (CONFIRMED, NOT_REPRODUCED, INDETERMINATE, DISMISSED) accept
// no further transitions. Actor 'ai' may only set confidence/suggest —
// any verification_state transition attempted by 'ai' throws and leaves
// the finding untouched. setAiConfidence NEVER changes verification_state.
//
// Every create/transition/confidence-set appends an AuditEvent to the
// append-only in-memory log in ./audit.js.

import { randomUUID } from 'node:crypto';
import { append } from './audit.js';

export const HYPOTHESIS = 'HYPOTHESIS';
export const VERIFYING = 'VERIFYING';
export const CONFIRMED = 'CONFIRMED';
export const NOT_REPRODUCED = 'NOT_REPRODUCED';
export const INDETERMINATE = 'INDETERMINATE';
export const DISMISSED = 'DISMISSED';

export const TERMINAL_STATES = new Set([CONFIRMED, NOT_REPRODUCED, INDETERMINATE, DISMISSED]);

const ALLOWED = {
  [HYPOTHESIS]: new Set([VERIFYING, DISMISSED]),
  [VERIFYING]: new Set([CONFIRMED, NOT_REPRODUCED, INDETERMINATE, DISMISSED]),
};

export function isTerminal(state) {
  return TERMINAL_STATES.has(state);
}

function requireReasonForDismissed(to, reason) {
  if (to === DISMISSED && (typeof reason !== 'string' || reason.trim() === '')) {
    throw new Error('transition to DISMISSED requires a reason');
  }
}

export function createFinding({ ruleId, file, line = null, evidence = '', aiConfidence = null, targetSha = null, actor = 'human' } = {}) {
  if (!ruleId || typeof ruleId !== 'string') throw new Error('createFinding requires ruleId');
  if (!file || typeof file !== 'string') throw new Error('createFinding requires file');
  if (aiConfidence !== null && aiConfidence !== undefined) {
    validateConfidence(aiConfidence);
  }
  const finding = {
    id: randomUUID(),
    ruleId,
    file,
    line,
    evidence,
    aiConfidence: aiConfidence ?? null,
    targetSha: targetSha ?? null,
    verification_state: HYPOTHESIS,
  };
  append('create', {
    findingId: finding.id,
    from: null,
    to: HYPOTHESIS,
    actor,
    reason: null,
  });
  return finding;
}

export function transition(finding, to, { actor = 'human', reason = null } = {}) {
  if (!finding || typeof finding !== 'object') throw new Error('transition requires a finding');
  if (actor === 'ai') {
    throw new Error("actor 'ai' may not transition verification_state (may only set confidence/suggest)");
  }
  const from = finding.verification_state;
  if (TERMINAL_STATES.has(from)) {
    throw new Error(`illegal transition: ${from} is terminal, accepts no transitions`);
  }
  const allowed = ALLOWED[from];
  if (!allowed || !allowed.has(to)) {
    throw new Error(`illegal transition: ${from} -> ${to}`);
  }
  requireReasonForDismissed(to, reason);
  finding.verification_state = to;
  append('transition', {
    findingId: finding.id,
    from,
    to,
    actor,
    reason: reason ?? null,
  });
  return finding;
}

function validateConfidence(v) {
  if (typeof v !== 'number' || Number.isNaN(v) || v < 0 || v > 1) {
    throw new Error('aiConfidence must be a number in [0, 1]');
  }
}

export function setAiConfidence(finding, v, actor = 'human') {
  if (!finding || typeof finding !== 'object') throw new Error('setAiConfidence requires a finding');
  validateConfidence(v);
  const from = finding.aiConfidence ?? null;
  finding.aiConfidence = v;
  // verification_state is intentionally left untouched.
  append('confidence', {
    findingId: finding.id,
    from,
    to: v,
    actor,
    reason: null,
  });
  return finding;
}
