// Runner → verify end-to-end pipeline.
//
// executePipeline({ finding, repoDir, targetSha, commands, env, policy })
// wires deterministic verification planning (lib/verify.js) to the
// isolated local runner (lib/runner.js). Zero-dep, no network:
//
//   planChecks(finding, policy) → createRun → startRun
//     → runLocal({ repoDir, targetSha, checks, timeoutMs, env })
//     → completeRun(finding, run, results, sealedEvidence)
//     → { run, finding, evidence, auditTrail }
//
// `commands` maps each required check type to:
//   { command: [argv0, ...args], refuteExitCode?: <non-zero int> }
// Commands are caller-supplied and deterministic. A required check type
// with no entry — or an entry outside the closed CHECK_TYPES set — throws
// fail-closed BEFORE anything executes (never shell out blindly).
//
// Outcome mapping (runner → verify): exit 0 → pass; exit ===
// refuteExitCode → refute (finding NOT_REPRODUCED); any other exit code,
// or TIMEOUT → fail (run FAIL, finding stays/enters VERIFYING — never
// silently CONFIRMED).
//
// Fail-closed edges:
//   - a runner SHA mismatch propagates as INVALID_VERIFICATION with the
//     finding untouched (completeRun never runs).
//   - an empty plan throws: zero evidence must never auto-CONFIRM
//     (Reviewed != Verified); the caller must decide explicitly.

import { CHECK_TYPES, planChecks, createRun, startRun, completeRun } from './verify.js';
import { runLocal } from './runner.js';
import { list } from './audit.js';

const KNOWN_CHECKS = new Set(CHECK_TYPES);

function pipelineError(message) {
  return new Error(`executePipeline: ${message}`);
}

function invalidVerification(message) {
  const err = new Error(`INVALID_VERIFICATION: ${message}`);
  err.code = 'INVALID_VERIFICATION';
  return err;
}

function normalizeCommands(commands) {
  if (!commands || typeof commands !== 'object' || Array.isArray(commands)) {
    throw pipelineError('commands must be an object mapping check type -> { command: [argv0, ...args] }');
  }
  const out = new Map();
  for (const [type, entry] of Object.entries(commands)) {
    if (!KNOWN_CHECKS.has(type)) {
      throw pipelineError(`unknown check type "${type}" (expected one of ${CHECK_TYPES.join(', ')})`);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw pipelineError(`check "${type}" must be { command: [...] }`);
    }
    const { command, refuteExitCode } = entry;
    if (!Array.isArray(command) || command.length === 0) {
      throw pipelineError(`check "${type}" needs a non-empty command array`);
    }
    for (const part of command) {
      if (typeof part !== 'string' || part === '') {
        throw pipelineError(`check "${type}" command entries must be non-empty strings`);
      }
    }
    if (refuteExitCode !== undefined && (!Number.isInteger(refuteExitCode) || refuteExitCode === 0)) {
      throw pipelineError(`check "${type}" refuteExitCode must be a non-zero integer`);
    }
    out.set(type, { command: [...command], refuteExitCode });
  }
  return out;
}

export async function executePipeline({
  finding,
  repoDir,
  targetSha = null,
  commands = {},
  env = {},
  policy = null,
} = {}) {
  if (!finding || typeof finding !== 'object' || !finding.id) {
    throw pipelineError('finding with an id is required');
  }
  if (typeof repoDir !== 'string' || repoDir === '') {
    throw pipelineError('repoDir is required');
  }

  // Validate caller-supplied commands BEFORE planning or executing anything.
  const byType = normalizeCommands(commands);

  // Deterministic plan. Throws on unknown or empty pinned policy checks.
  const plan = planChecks(finding, policy);

  // Zero evidence must never auto-confirm.
  if (plan.length === 0) {
    throw pipelineError('empty verification plan: refusing to auto-CONFIRM on zero evidence (Reviewed != Verified)');
  }

  // Every required check needs an explicit command — never shell out blindly.
  const missing = plan.filter((t) => !byType.has(t));
  if (missing.length > 0) {
    throw pipelineError(
      `no command configured for required check(s): ${missing.join(', ')} (fail-closed: refusing to shell out blindly)`,
    );
  }

  // Pin the target SHA: the finding must pin one, and an explicit targetSha
  // must agree with it.
  const pinned = finding.targetSha ?? null;
  if (typeof pinned !== 'string' || pinned === '') {
    throw pipelineError('finding must pin a targetSha');
  }
  if (targetSha !== null && targetSha !== undefined && pinned !== targetSha) {
    throw invalidVerification(
      `finding targetSha (${pinned}) does not match requested targetSha (${targetSha})`,
    );
  }
  const effectiveSha = targetSha ?? pinned;

  const mark = list().length;
  const run = createRun(finding, policy);
  startRun(run);

  // Execute in isolation. A SHA mismatch throws INVALID_VERIFICATION here,
  // before completeRun — the finding is untouched.
  const checks = plan.map((type) => ({ type, command: byType.get(type).command }));
  const exec = await runLocal({
    repoDir,
    targetSha: effectiveSha,
    checks,
    timeoutMs: policy?.timeoutMs,
    env: env ?? {},
    secretKeys: Array.isArray(policy?.secretKeys) ? policy.secretKeys : [],
    runId: run.id,
  });

  // completeRun accepts pass | fail | refute for every required check.
  const results = {};
  for (const entry of exec.checks) {
    const refuteCode = byType.get(entry.type)?.refuteExitCode;
    if (entry.status === 'PASS') results[entry.type] = 'pass';
    else if (refuteCode !== undefined && entry.exitCode === refuteCode) results[entry.type] = 'refute';
    else results[entry.type] = 'fail';
  }

  completeRun(finding, run, results, exec.evidenceItems);

  return { run, finding, evidence: exec.evidenceItems, auditTrail: list().slice(mark) };
}

export default { executePipeline };
