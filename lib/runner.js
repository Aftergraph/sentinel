// Verify-runner isolation — local runner.
//
// runLocal({ repoDir, targetSha, checks, timeoutMs, env }) executes checks
// in an isolated temp copy of repoDir (never in place):
//   1. copy repoDir -> temp dir
//   2. verify `git rev-parse HEAD` in the copy equals targetSha
//      (mismatch -> throw INVALID_VERIFICATION, nothing executed)
//   3. run each check { type, command[] } sequentially as a bounded child
//      process (timeout kill -> status TIMEOUT)
//   4. scrub secrets, truncate output, seal one EvidenceItem per check,
//      append audit events
//   5. always remove the temp dir (even on timeout/throw)
//
// Zero-dep Node, no network. Child env is allowlist-only: exactly the
// caller-passed `env` object, never full process inheritance.

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { append } from './audit.js';
import { sealEvidence } from './evidence.js';

export const DEFAULT_TIMEOUT_MS = 120000;
export const MAX_TIMEOUT_MS = 600000;
export const MAX_OUTPUT_BYTES = 64 * 1024;

function invalidVerification(msg) {
  const err = new Error(`INVALID_VERIFICATION: ${msg}`);
  err.code = 'INVALID_VERIFICATION';
  return err;
}

function normalizeTimeout(timeoutMs) {
  if (timeoutMs === undefined || timeoutMs === null) return DEFAULT_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`runLocal: timeoutMs must be a positive number (got ${String(timeoutMs)})`);
  }
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`runLocal: timeoutMs ${timeoutMs} exceeds maximum ${MAX_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function normalizeEnv(env) {
  if (env === undefined || env === null) return {};
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw new Error('runLocal: env must be a plain object');
  }
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof k !== 'string' || k === '') throw new Error('runLocal: env keys must be non-empty strings');
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

function normalizeChecks(checks) {
  if (!Array.isArray(checks)) throw new Error('runLocal: checks must be an array');
  for (const c of checks) {
    if (!c || typeof c !== 'object') throw new Error('runLocal: each check must be { type, command[] }');
    if (typeof c.type !== 'string' || c.type === '') {
      throw new Error('runLocal: each check needs a non-empty string type');
    }
    if (!Array.isArray(c.command) || c.command.length === 0) {
      throw new Error(`runLocal: check "${c.type}" needs a non-empty command array`);
    }
    for (const part of c.command) {
      if (typeof part !== 'string' || part === '') {
        throw new Error(`runLocal: check "${c.type}" command entries must be non-empty strings`);
      }
    }
  }
  return checks;
}

function secretValues(env, secretKeys) {
  const values = [];
  if (!Array.isArray(secretKeys)) return values;
  for (const k of secretKeys) {
    if (typeof k !== 'string' || k === '') continue;
    if (Object.prototype.hasOwnProperty.call(env, k)) {
      const v = env[k];
      if (v !== undefined && v !== null && String(v) !== '') values.push(String(v));
    } else {
      // Tolerate callers passing raw secret values instead of key names.
      values.push(k);
    }
  }
  return values;
}

function scrubAndTruncate(text, secrets) {
  let out = typeof text === 'string' ? text : String(text ?? '');
  for (const s of secrets) {
    if (!s) continue;
    out = out.split(s).join('[REDACTED]');
  }
  if (out.length > MAX_OUTPUT_BYTES) out = out.slice(0, MAX_OUTPUT_BYTES);
  return out;
}

function runOne(command, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let child;
    try {
      child = spawn(command[0], command.slice(1), {
        cwd,
        env: { ...env },
        shell: false,
        // Own process group so timeout kills grandchildren too (see above).
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ exitCode: null, stdout: '', stderr: String(err?.message ?? err), durationMs: Date.now() - start, timedOut: false, spawnError: err });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole process group (a `sh -c 'sleep 999 &'` orphan must
      // not survive the timeout); fall back to the child alone.
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch {}
      }
    }, timeoutMs);
    // No unref: the timer must fire even if the event loop would otherwise
    // drain, or a hung child outlives the timeout silently.
    const capAppend = (current, chunk) => {
      if (current.length >= MAX_OUTPUT_BYTES) return current;
      return current + chunk.slice(0, MAX_OUTPUT_BYTES - current.length);
    };
    child.stdout.on('data', (d) => {
      stdout = capAppend(stdout, d.toString('utf8'));
    });
    child.stderr.on('data', (d) => {
      stderr = capAppend(stderr, d.toString('utf8'));
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr + String(err?.message ?? err), durationMs: Date.now() - start, timedOut: false, spawnError: err });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        resolve({ exitCode: null, stdout, stderr, durationMs: Date.now() - start, timedOut: true });
      } else {
        resolve({ exitCode: code, stdout, stderr, durationMs: Date.now() - start, timedOut: false });
      }
    });
  });
}

function readHeadSha(workDir) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: workDir,
    encoding: 'utf8',
    timeout: 15000,
  });
  if (r.error) throw invalidVerification(`git rev-parse HEAD failed: ${r.error.message}`);
  if (r.status !== 0) {
    throw invalidVerification(`git rev-parse HEAD failed: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
  }
  return String(r.stdout || '').trim();
}

// Clone/copy repoDir to a temp dir, verify SHA, run checks sequentially.
// Returns { runId, targetSha, workDir, tmpBase, checks, results, evidenceItems,
//           durationMs, status, run }. Throws with code INVALID_VERIFICATION
// on SHA mismatch (nothing executed). Temp dir is always removed; the
// removed path is returned (and attached to thrown errors as err.workDir).
export async function runLocal({
  repoDir,
  targetSha,
  checks = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = {},
  secretKeys = [],
  runId = randomUUID(),
  actor = 'runner',
} = {}) {
  if (typeof repoDir !== 'string' || repoDir === '') throw new Error('runLocal: repoDir is required');
  if (typeof targetSha !== 'string' || targetSha === '') throw new Error('runLocal: targetSha is required');
  const timeout = normalizeTimeout(timeoutMs);
  const childEnv = normalizeEnv(env);
  const list = normalizeChecks(checks);
  if (!Array.isArray(secretKeys)) throw new Error('runLocal: secretKeys must be an array');
  let stat;
  try {
    stat = statSync(repoDir);
  } catch {
    throw new Error(`runLocal: repoDir not found: ${repoDir}`);
  }
  if (!stat.isDirectory()) throw new Error(`runLocal: repoDir is not a directory: ${repoDir}`);

  const runStarted = Date.now();
  const tmpBase = mkdtempSync(path.join(os.tmpdir(), 'sentinel-run-'));
  const workDir = path.join(tmpBase, 'repo');
  const attachPaths = (err) => {
    if (err && typeof err === 'object') {
      if (err.workDir === undefined) err.workDir = workDir;
      if (err.tmpBase === undefined) err.tmpBase = tmpBase;
    }
    return err;
  };

  try {
    append('runner_start', {
      findingId: runId,
      from: repoDir,
      to: targetSha,
      actor,
      reason: list.map((c) => c.type).join(','),
    });

    cpSync(repoDir, workDir, { recursive: true });

    const actualSha = readHeadSha(workDir);
    if (actualSha !== targetSha) {
      throw invalidVerification(`checked-out SHA (${actualSha || '<empty>'}) does not match targetSha (${targetSha})`);
    }

    const secrets = secretValues(childEnv, secretKeys);
    const detailed = [];
    const evidenceItems = [];

    for (const check of list) {
      const commandJoined = check.command.join(' ');
      const raw = await runOne(check.command, { cwd: workDir, env: childEnv, timeoutMs: timeout });
      const stdout = scrubAndTruncate(raw.stdout, secrets);
      const stderr = scrubAndTruncate(raw.stderr, secrets);
      const status = raw.timedOut ? 'TIMEOUT' : raw.exitCode === 0 ? 'PASS' : 'FAIL';
      const result = status.toLowerCase();
      const entry = {
        type: check.type,
        command: [...check.command],
        status,
        exitCode: raw.exitCode,
        stdout,
        stderr,
        durationMs: raw.durationMs,
      };
      detailed.push(entry);
      const evidence = sealEvidence({
        runId,
        targetSha,
        type: check.type,
        command: commandJoined,
        exitCode: raw.exitCode,
        result,
        artifacts: [],
      });
      evidenceItems.push(evidence);
      append('runner_check', {
        findingId: runId,
        from: check.type,
        to: status,
        actor,
        reason: commandJoined,
      });
    }

    const overall = detailed.every((d) => d.status === 'PASS') ? 'PASS' : 'FAIL';
    const durationMs = Date.now() - runStarted;
    append('runner_complete', {
      findingId: runId,
      from: String(list.length),
      to: overall,
      actor,
      reason: targetSha,
    });
    const run = {
      id: runId,
      targetSha,
      checks: detailed.map((d) => ({ type: d.type, status: d.status })),
      status: overall,
    };
    return {
      runId,
      targetSha,
      workDir,
      tmpBase,
      checks: detailed,
      results: detailed,
      evidenceItems,
      durationMs,
      status: overall,
      run,
    };
  } catch (err) {
    try {
      append('runner_error', {
        findingId: runId,
        from: targetSha ?? null,
        to: err?.code ?? 'ERROR',
        actor,
        reason: String(err?.message ?? err).slice(0, 500),
      });
    } catch {}
    throw attachPaths(err);
  } finally {
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {}
  }
}

export default { runLocal, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MAX_OUTPUT_BYTES };
