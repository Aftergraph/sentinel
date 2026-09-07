// Sentinel GitHub check-runs production transport (zero-dep, `gh api`).
//
// createGhClient() builds the { createCheckRun, updateCheckRun } api object
// that apps/github/checks.js postCheck() expects, on top of an INJECTED
// exec(argv, opts) function. The default exec runs `gh api ...` via
// node:child_process with NO shell (argv array, never a shell string), so
// summaries carrying newlines/markdown can neither break quoting nor inject
// flags — unlike the string-based ghApi() convention in lib/review.js.
//
// Auth: a token (e.g. from resolveInstallationToken()) travels via the
// GH_TOKEN env var only — it is NEVER placed in argv, NEVER logged, and
// NEVER persisted. Every exec failure (non-zero exit, missing gh binary,
// non-JSON output) throws fail-closed with truncated stderr attached.
import { execFileSync } from 'node:child_process';
import { CHECK_NAME } from './checks.js';

const MAX_STDERR_CHARS = 2000;
const MAX_OUTPUT_CHARS = 500;

export function defaultExec(argv, opts = {}) {
  return execFileSync('gh', argv, { encoding: 'utf8', ...opts });
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…(truncated ${s.length - max} chars)` : s;
}

function isMissingBinary(err) {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return false;
  if (err.code === 'ENOENT') return true;
  const msg = typeof err.message === 'string' ? err.message : '';
  return /ENOENT/i.test(msg) && /(^|\W)gh(\W|$)/i.test(msg);
}

// Join stderr/stdout carried by a child_process-style error. Never touches
// argv/env, so no secret can leak into the message through this path.
function execOutput(err) {
  const parts = [];
  for (const key of ['stderr', 'stdout']) {
    const v = err?.[key];
    if (typeof v === 'string' && v.trim() !== '') parts.push(v);
    else if (v instanceof Buffer && v.length > 0) parts.push(v.toString('utf8'));
  }
  if (parts.length > 0) return parts.join('\n').trim();
  return typeof err?.message === 'string' && err.message !== '' ? err.message : String(err);
}

function ghFailure(what, err) {
  if (isMissingBinary(err)) {
    return new Error(
      `${what} failed (fail closed): gh CLI binary not found. ` +
        'Install GitHub CLI from https://cli.github.com and run `gh auth login`, then retry.',
    );
  }
  const exit = err?.status ?? err?.exitCode ?? err?.code ?? '?';
  return new Error(`${what} failed (fail closed): gh api exited ${exit}: ${truncate(execOutput(err), MAX_STDERR_CHARS)}`);
}

// Run one `gh api` call through the injected exec; parse stdout JSON.
function callGh(run, what, argv, opts = {}) {
  let out;
  try {
    out = run(argv, opts);
  } catch (err) {
    throw ghFailure(what, err);
  }
  const text = typeof out === 'string' ? out : out instanceof Buffer ? out.toString('utf8') : String(out ?? '');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} failed (fail closed): gh api returned non-JSON output: ${truncate(text.trim(), MAX_OUTPUT_CHARS)}`);
  }
}

function requireRepo(repo) {
  if (typeof repo !== 'string' || repo.trim() === '') {
    throw new Error('gh-client requires repo (pass createGhClient({ repo }) or per-call { repo }) (fail closed)');
  }
  return repo;
}

// `-f` (raw-field: static strings, no @file reads, no type magic) carries
// every value; nested output.* uses gh's key[subkey]=value syntax.
function appendFields(argv, params, { defaults = false } = {}) {
  const name = params.name ?? (defaults ? CHECK_NAME : undefined);
  const status = params.status ?? (defaults ? 'completed' : undefined);
  const scalar = { name, head_sha: params.head_sha, status, conclusion: params.conclusion };
  for (const [key, value] of Object.entries(scalar)) {
    if (value !== undefined && value !== null) argv.push('-f', `${key}=${value}`);
  }
  const output = params.output;
  if (output !== undefined && (typeof output !== 'object' || output === null || Array.isArray(output))) {
    throw new Error('gh-client requires output to be an object { title, summary, text } (fail closed)');
  }
  for (const key of ['title', 'summary', 'text']) {
    const value = output?.[key];
    if (value !== undefined && value !== null) argv.push('-f', `output[${key}]=${value}`);
  }
  return argv;
}

// Build the { createCheckRun, updateCheckRun } api expected by checks.js.
// opts: { exec (injected, default defaultExec), repo (bound default),
//         token (sent via GH_TOKEN env only, never argv) }.
export function createGhClient({ exec = defaultExec, repo, token } = {}) {
  const run = typeof exec === 'function' ? exec : defaultExec;
  const callOpts = token === undefined || token === null ? {} : { env: { ...process.env, GH_TOKEN: token } };

  async function createCheckRun(params = {}) {
    const endpoint = `repos/${requireRepo(params.repo ?? repo)}/check-runs`;
    if (typeof params.head_sha !== 'string' || params.head_sha.trim() === '') {
      throw new Error('gh-client createCheckRun requires head_sha (fail closed)');
    }
    if (typeof params.conclusion !== 'string' || params.conclusion.trim() === '') {
      throw new Error('gh-client createCheckRun requires conclusion (fail closed)');
    }
    const argv = appendFields(['api', endpoint, '--method', 'POST'], params, { defaults: true });
    return callGh(run, `create check-run for ${endpoint}`, argv, callOpts);
  }

  async function updateCheckRun(id, params = {}) {
    if (id === undefined || id === null || String(id).trim() === '') {
      throw new Error('gh-client updateCheckRun requires a check-run id (fail closed)');
    }
    const endpoint = `repos/${requireRepo(params.repo ?? repo)}/check-runs/${id}`;
    const argv = appendFields(['api', endpoint, '--method', 'PATCH'], params);
    return callGh(run, `update check-run ${String(id)}`, argv, callOpts);
  }

  return { createCheckRun, updateCheckRun };
}

// Exchange an App JWT for an installation token via `gh api`
// (POST app/installations/{id}/access_tokens). Returns { token, expiresAt }
// WITHOUT logging or persisting the token — the JWT travels via GH_TOKEN
// env, and the token is returned to the caller only.
export async function resolveInstallationToken({ appJwt, installationId, exec = defaultExec } = {}) {
  if (typeof appJwt !== 'string' || appJwt.trim() === '') {
    throw new Error('resolveInstallationToken requires appJwt (fail closed)');
  }
  if (installationId === undefined || installationId === null || String(installationId).trim() === '') {
    throw new Error('resolveInstallationToken requires installationId (fail closed)');
  }
  const run = typeof exec === 'function' ? exec : defaultExec;
  const what = `installation token for ${String(installationId)}`;
  const parsed = callGh(
    run,
    what,
    ['api', `app/installations/${installationId}/access_tokens`, '--method', 'POST'],
    { env: { ...process.env, GH_TOKEN: appJwt } },
  );
  if (!parsed || typeof parsed !== 'object' || typeof parsed.token !== 'string' || parsed.token === '') {
    throw new Error(`${what} failed (fail closed): access_tokens returned no token`);
  }
  return { token: parsed.token, expiresAt: parsed.expires_at ?? null };
}
