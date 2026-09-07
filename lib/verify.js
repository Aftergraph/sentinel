// Verification wiring — ENGINE S3.
//
// Deterministic, offline mapping from findings to required verification
// checks plus the VerificationRun lifecycle. No LLM, no network: every
// decision is a pure function of (ruleId, severity, policy).
//
// Closed check set:
//   BUILD, TEST, TYPECHECK, LINT, STATIC_ANALYSIS, SECRET_SCAN,
//   CONTRACT_TEST, POLICY_CHECK
//
// planChecks(finding, policy) — required check types for a finding.
//   severity = policy.severity ?? finding.severity ?? SEVERITY_MAP[ruleId]
//   ?? 'security' (fail closed, mirroring review.js computeVerdict).
//   Base checks come from a severity table; ruleId keyword overlays add
//   checks. Output is deduplicated and ordered by CHECK_TYPES, so the
//   same input always yields the same array. policy.checks (or policy as
//   a bare array) pins an explicit required set; policy.extraChecks unions
//   extras onto the table result. Unknown check types throw.
//
// VerificationRun { id, findingId, targetSha, checks:[{type,status}], status }
//   status: PENDING -> RUNNING -> PASS | FAIL.
//   createRun(finding, policy) plans and returns a PENDING run.
//   startRun(run) moves PENDING -> RUNNING.
//   completeRun(finding, run, results, evidenceItems) — or equivalently
//   completeRun(run, results, evidenceItems) when the run was created via
//   createRun (finding is bound at creation), or
//   completeRun(run, finding, results, evidenceItems).
//   results maps every required check type to pass | fail | refute
//   (object map or [{ type, status|outcome|result }] array; synonyms like
//   'passed'/'failed'/'refuted'/'not_reproduced' accepted, case-insensitive).
//   Every required check must have a result — a missing one throws with
//   code BLOCKED and mutates nothing. Sealed evidence whose targetSha does
//   not equal the run (and finding) targetSha throws INVALID_VERIFICATION.
//   Outcome: any refute -> finding NOT_REPRODUCED; all pass -> CONFIRMED;
//   otherwise the finding stays (or enters) VERIFYING. run.status is PASS
//   iff all checks pass, else FAIL. Audit events are appended for plan,
//   start, each evidence attach, each finding transition, and completion.

import { randomUUID } from 'node:crypto';
import { append } from './audit.js';
import { transition, VERIFYING, CONFIRMED, NOT_REPRODUCED, HYPOTHESIS } from './finding.js';
import { attachEvidence } from './evidence.js';
import { SEVERITY_MAP } from './rulepack.js';

export const CHECK_TYPES = [
  'BUILD',
  'TEST',
  'TYPECHECK',
  'LINT',
  'STATIC_ANALYSIS',
  'SECRET_SCAN',
  'CONTRACT_TEST',
  'POLICY_CHECK',
];

const CHECK_INDEX = new Map(CHECK_TYPES.map((t, i) => [t, i]));

export const PENDING = 'PENDING';
export const RUNNING = 'RUNNING';
export const PASS = 'PASS';
export const FAIL = 'FAIL';

// Base required checks per severity. Unknown severities fail closed onto
// the DEFAULT_CHECKS (static analysis + policy gate).
const SEVERITY_CHECKS = {
  security: ['STATIC_ANALYSIS', 'SECRET_SCAN', 'POLICY_CHECK'],
  reliability: ['BUILD', 'TEST', 'POLICY_CHECK'],
  correctness: ['BUILD', 'TEST', 'TYPECHECK'],
  data: ['BUILD', 'CONTRACT_TEST', 'POLICY_CHECK'],
  performance: ['BUILD', 'TEST', 'CONTRACT_TEST'],
  style: ['LINT'],
};

const DEFAULT_CHECKS = ['STATIC_ANALYSIS', 'POLICY_CHECK'];

// Deterministic ruleId keyword overlays: [pattern, extra checks].
// Pure string matching — no I/O, no network.
const RULE_OVERLAYS = [
  [/secret|private-key/i, ['SECRET_SCAN']],
  [/unauthenticated|api-endpoints/i, ['CONTRACT_TEST']],
  [/transaction|rollback/i, ['CONTRACT_TEST']],
  [/migration|sql|schema|delete|update|backup|guard|destructive/i, ['CONTRACT_TEST']],
  [/n-plus-one|dataloader|eager-load|pagination|list-query|nested-fetch|resolver/i, ['CONTRACT_TEST']],
  [/eval|tls/i, ['STATIC_ANALYSIS']],
  [/localhost|console-log|strict-equality|var-instead/i, ['LINT']],
  [/lockfile|github-action|unpinned|manifest/i, ['POLICY_CHECK']],
  [/process-exit|sync-io|route-handler/i, ['BUILD', 'TEST']],
];

function orderChecks(types) {
  return [...new Set(types)].sort((a, b) => CHECK_INDEX.get(a) - CHECK_INDEX.get(b));
}

function assertKnownChecks(types, what) {
  for (const t of types) {
    if (!CHECK_INDEX.has(t)) {
      throw new Error(`${what}: unknown check type "${t}" (expected one of ${CHECK_TYPES.join(', ')})`);
    }
  }
}

export function severityOf(finding, policy) {
  if (policy && typeof policy === 'object' && typeof policy.severity === 'string') {
    return policy.severity;
  }
  if (finding && typeof finding.severity === 'string') return finding.severity;
  if (finding && typeof finding.ruleId === 'string' && SEVERITY_MAP[finding.ruleId]) {
    return SEVERITY_MAP[finding.ruleId];
  }
  return 'security';
}

export function planChecks(finding, policy = null) {
  if (!finding || typeof finding !== 'object' || typeof finding.ruleId !== 'string' || finding.ruleId === '') {
    throw new Error('planChecks requires a finding with a ruleId');
  }
  // Explicit pin wins: policy.checks, or policy as a bare array.
  const pinned = Array.isArray(policy) ? policy : policy?.checks;
  if (pinned !== undefined && pinned !== null) {
    if (!Array.isArray(pinned) || pinned.length === 0) {
      throw new Error('planChecks: policy.checks must be a non-empty array of check types');
    }
    assertKnownChecks(pinned, 'planChecks policy.checks');
    return orderChecks(pinned);
  }
  const severity = severityOf(finding, policy);
  const base = SEVERITY_CHECKS[severity] ?? DEFAULT_CHECKS;
  const extra = [];
  for (const [re, checks] of RULE_OVERLAYS) {
    if (re.test(finding.ruleId)) extra.push(...checks);
  }
  if (policy && typeof policy === 'object' && Array.isArray(policy.extraChecks)) {
    assertKnownChecks(policy.extraChecks, 'planChecks policy.extraChecks');
    extra.push(...policy.extraChecks);
  }
  return orderChecks([...base, ...extra]);
}

// Finding bound at creation so the spec-literal
// completeRun(run, results, evidenceItems) form can resolve it.
const runFindings = new Map();

export function createRun(finding, policy = null, { actor = 'human' } = {}) {
  if (!finding || typeof finding !== 'object' || !finding.id) {
    throw new Error('createRun requires a finding with an id');
  }
  const types = planChecks(finding, policy);
  const run = {
    id: randomUUID(),
    findingId: finding.id,
    targetSha: finding.targetSha ?? null,
    checks: types.map((type) => ({ type, status: PENDING })),
    status: PENDING,
  };
  runFindings.set(run.id, finding);
  append('verify_plan', {
    findingId: finding.id,
    from: finding.ruleId ?? null,
    to: types.join(','),
    actor,
    reason: run.targetSha,
  });
  return run;
}

export function startRun(run, { actor = 'human' } = {}) {
  if (!run || typeof run !== 'object' || !Array.isArray(run.checks)) {
    throw new Error('startRun requires a VerificationRun');
  }
  if (run.status !== PENDING) {
    throw new Error(`illegal run transition: ${run.status} -> ${RUNNING} (only PENDING may start)`);
  }
  run.status = RUNNING;
  for (const c of run.checks) c.status = RUNNING;
  append('verify_start', {
    findingId: run.findingId ?? null,
    from: PENDING,
    to: RUNNING,
    actor,
    reason: run.targetSha ?? null,
  });
  return run;
}

function isFindingLike(v) {
  return !!v && typeof v === 'object' && ('ruleId' in v || 'verification_state' in v);
}

function normalizeOutcome(outcome) {
  const key = String(outcome).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (['PASS', 'PASSED', 'OK', 'SUCCESS', 'SUCCESSFUL'].includes(key)) return 'pass';
  if (['FAIL', 'FAILED', 'FAILURE', 'ERROR'].includes(key)) return 'fail';
  if (['REFUTE', 'REFUTED', 'REFUTES', 'NOT_REPRODUCED', 'NOTREPRODUCED', 'DISPROVED'].includes(key)) return 'refute';
  throw new Error(
    `unknown check outcome "${outcome}" (expected pass | fail | refute)`,
  );
}

function normalizeResults(results, required) {
  let entries;
  if (Array.isArray(results)) {
    entries = results.map((r) => {
      if (!r || typeof r !== 'object') throw new Error('results array entries must be objects with a type');
      const type = r.type ?? r.check;
      const outcome = r.status ?? r.outcome ?? r.result;
      if (typeof type !== 'string' || outcome === undefined) {
        throw new Error('results array entries must carry { type, status|outcome|result }');
      }
      return [type, outcome];
    });
  } else if (results && typeof results === 'object') {
    entries = Object.entries(results);
  } else {
    throw new Error('completeRun requires results as an object map or an array');
  }
  const map = new Map();
  for (const [type, outcome] of entries) map.set(type, normalizeOutcome(outcome));
  const missing = required.filter((t) => !map.has(t));
  if (missing.length > 0) {
    const err = new Error(`BLOCKED: missing result for required check(s): ${missing.join(', ')}`);
    err.code = 'BLOCKED';
    err.missing = missing;
    throw err;
  }
  return map;
}

function resolveCompleteArgs(args) {
  // (finding, run, results, evidenceItems, opts?)
  if (isFindingLike(args[0])) {
    return { finding: args[0], run: args[1], results: args[2], evidenceItems: args[3] ?? [], opts: args[4] ?? {} };
  }
  // (run, finding, results, evidenceItems, opts?)
  if (isFindingLike(args[1])) {
    return { finding: args[1], run: args[0], results: args[2], evidenceItems: args[3] ?? [], opts: args[4] ?? {} };
  }
  // (run, results, evidenceItems, opts?{finding}) — finding via createRun binding.
  const run = args[0];
  const opts = args[3] && typeof args[3] === 'object' && !Array.isArray(args[3]) ? args[3] : {};
  const finding = opts.finding ?? (run ? runFindings.get(run.id) : undefined);
  return { finding, run, results: args[1], evidenceItems: args[2] ?? [], opts };
}

export function completeRun(...args) {
  const { finding, run, results, evidenceItems, opts } = resolveCompleteArgs(args);
  const actor = opts?.actor ?? 'human';
  if (!isFindingLike(finding) || !finding.id) {
    throw new Error('completeRun requires a finding (pass it explicitly or create the run via createRun)');
  }
  if (!run || typeof run !== 'object' || !Array.isArray(run.checks)) {
    throw new Error('completeRun requires a VerificationRun');
  }
  if (run.status === PASS || run.status === FAIL) {
    throw new Error(`illegal run transition: ${run.status} is terminal, run already complete`);
  }
  const required = run.checks.map((c) => c.type);
  // Validate everything before mutating anything.
  const map = normalizeResults(results, required);
  const items = evidenceItems ?? [];
  if (!Array.isArray(items)) throw new Error('completeRun evidenceItems must be an array');
  for (const ev of items) {
    if (!ev || typeof ev !== 'object' || !ev.id) {
      throw new Error('completeRun evidenceItems must be sealed evidence with an id');
    }
    if (run.targetSha !== undefined && run.targetSha !== null && ev.targetSha !== run.targetSha) {
      const err = new Error(
        `INVALID_VERIFICATION: evidence targetSha (${ev.targetSha}) does not match run targetSha (${run.targetSha})`,
      );
      err.code = 'INVALID_VERIFICATION';
      throw err;
    }
  }
  if (
    finding.targetSha !== undefined && finding.targetSha !== null &&
    run.targetSha !== undefined && run.targetSha !== null &&
    finding.targetSha !== run.targetSha
  ) {
    const err = new Error(
      `INVALID_VERIFICATION: run targetSha (${run.targetSha}) does not match finding targetSha (${finding.targetSha})`,
    );
    err.code = 'INVALID_VERIFICATION';
    throw err;
  }

  if (run.status === PENDING) startRun(run, { actor });

  const outcomes = required.map((t) => map.get(t));
  const outcome = outcomes.includes('refute')
    ? NOT_REPRODUCED
    : outcomes.every((o) => o === 'pass')
      ? CONFIRMED
      : VERIFYING;

  const from = run.status;
  if (finding.verification_state === HYPOTHESIS) {
    transition(finding, VERIFYING, { actor });
  }
  if (outcome === CONFIRMED) transition(finding, CONFIRMED, { actor });
  else if (outcome === NOT_REPRODUCED) transition(finding, NOT_REPRODUCED, { actor });
  // else: stays (or just entered) VERIFYING.

  for (const ev of items) attachEvidence(finding, ev, { actor });

  for (const c of run.checks) {
    const o = map.get(c.type);
    c.status = o === 'pass' ? PASS : o === 'fail' ? FAIL : 'REFUTED';
  }
  run.status = outcome === CONFIRMED ? PASS : FAIL;
  run.outcome = outcome;
  append('verify_complete', {
    findingId: finding.id,
    from,
    to: run.status,
    actor,
    reason: outcome,
  });
  return run;
}
