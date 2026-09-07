// GitHub App installation store (vertical slice 0+1).
//
// File-backed JSON registry of installations: one tenant-scoped record per
// installationId, keyed by String(installationId):
//   { installationId, accountLogin, repos[], installedAt }
//
// handleInstallation() validates the webhook payload shape (missing fields
// throw — fail closed), upserts idempotently (redelivery merges repo names
// with no duplicates), and appends one `integration.changed` audit event
// per delivery via ../../lib/audit.js.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { append } from '../../lib/audit.js';

export function defaultStorePath() {
  return join(homedir(), '.sentinel', 'github-installations.json');
}

export function defaultPrStorePath() {
  return join(homedir(), '.sentinel', 'github-prs.json');
}

// Load the store object (key -> record). Missing file yields an empty
// store; a corrupt or non-object file THROWS fail-closed — silently
// resetting installation bindings would let PRs merge unverified.
export function loadStore(path = defaultStorePath()) {
  if (!existsSync(path)) return {};
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`github store: corrupt store file (${path}): ${err.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`github store: corrupt store file (${path}): not an object`);
  }
  return raw;
}

export function saveStore(store, path = defaultStorePath()) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    throw new Error('saveStore requires a store object');
  }
  mkdirSync(dirname(path), { recursive: true });
  // Atomic write via uniquely-named tmp (no predictable sibling, no partial).
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
  renameSync(tmp, path);
  return store;
}

export function getInstallation(installationId, path = defaultStorePath()) {
  if (installationId === undefined || installationId === null || installationId === '') {
    throw new Error('getInstallation requires installationId');
  }
  return loadStore(path)[String(installationId)] || null;
}

export function listInstallations(path = defaultStorePath()) {
  return Object.values(loadStore(path));
}

export function removeInstallation(installationId, path = defaultStorePath()) {
  if (installationId === undefined || installationId === null || installationId === '') {
    throw new Error('removeInstallation requires installationId');
  }
  const store = loadStore(path);
  const prev = store[String(installationId)] || null;
  delete store[String(installationId)];
  saveStore(store, path);
  return prev;
}

// Normalize payload.repositories to deduped full-name strings. Accepts
// GitHub shapes ({ full_name }), short shapes ({ name }), or plain
// strings. Absent repositories default to []; a non-array throws.
function repoNames(repositories) {
  if (repositories === undefined) return [];
  if (!Array.isArray(repositories)) {
    throw new Error('handleInstallation requires payload.repositories to be an array');
  }
  const out = [];
  for (const r of repositories) {
    const name = typeof r === 'string' ? r : r?.full_name ?? r?.name;
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error('handleInstallation requires each repository to carry a name');
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

// Upsert one installation record from an `installation` webhook payload.
// Expected shape (GitHub `installation` event):
//   { action, installation: { id, account: { login } }, repositories? }
// Throws on missing installation.id / installation.account.login (fail
// closed). Redelivery of the same installationId merges repos (no
// duplicates) and keeps the original installedAt. Every delivery —
// install, update, or delete — appends one `integration.changed` event.
// Action 'deleted' drops the record and returns null.
export function handleInstallation(payload, { storePath = defaultStorePath() } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('handleInstallation requires a payload');
  }
  const inst = payload.installation;
  if (!inst || typeof inst !== 'object') {
    throw new Error('handleInstallation requires payload.installation');
  }
  const installationId = inst.id ?? payload.installationId;
  if (installationId === undefined || installationId === null || installationId === '') {
    throw new Error('handleInstallation requires installation.id');
  }
  const accountLogin = inst.account?.login ?? payload.accountLogin;
  if (typeof accountLogin !== 'string' || accountLogin.trim() === '') {
    throw new Error('handleInstallation requires installation.account.login');
  }
  const key = String(installationId);
  const action = payload.action || 'created';

  if (action === 'deleted') {
    const store = loadStore(storePath);
    const prev = store[key] || null;
    delete store[key];
    saveStore(store, storePath);
    append('integration.changed', {
      actor: 'github-app',
      reason: `installation:deleted:${key}:${accountLogin}`,
    });
    return null;
  }

  const repos = repoNames(payload.repositories);
  const store = loadStore(storePath);
  const prev = store[key] || null;
  const merged = prev ? [...prev.repos] : [];
  for (const name of repos) {
    if (!merged.includes(name)) merged.push(name);
  }
  const record = {
    installationId,
    accountLogin,
    repos: merged,
    installedAt: prev?.installedAt ?? new Date().toISOString(),
  };
  store[key] = record;
  saveStore(store, storePath);
  append('integration.changed', {
    actor: 'github-app',
    reason: `installation:${action}:${key}:${accountLogin}:${record.repos.length}repos`,
  });
  return record;
}

// ---- Slice 2: repo-select → PR-ingest → SHA-capture ----
//
// PR records live in a separate file-backed JSON registry (keyed by
// `${repo}#${prNumber}`):
//   { repo, prNumber, headSha, baseSha, ingestedAt }
// A repo is "known" when some installation record claims it (via install
// payload repositories or selectRepo). ingestPR for an unknown repo is an
// ignored event ({ ignored: true }, no throw, no audit). Every mutation
// appends one audit event via ../../lib/audit.js.

const HEX40 = /^[0-9a-f]{40}$/i;

export function isHeadSha(value) {
  return typeof value === 'string' && HEX40.test(value);
}

function requireSha(name, value) {
  if (!isHeadSha(value)) {
    throw new Error(`ingestPR requires 40-hex ${name}`);
  }
  return value;
}

// Accept a bare path string (a store file) or an opts object. PR state
// derives from prStorePath when given, otherwise sits next to storePath
// so one tmp dir isolates both registries.
function resolveInstallPath(opts) {
  if (typeof opts === 'string') return opts;
  if (opts && typeof opts === 'object' && typeof opts.storePath === 'string') {
    return opts.storePath;
  }
  return defaultStorePath();
}

function resolvePrPath(opts) {
  if (typeof opts === 'string') return opts;
  if (opts && typeof opts === 'object') {
    const p = opts.prStorePath ?? opts.prPath ?? opts.ingestStorePath ?? opts.ingestPath;
    if (typeof p === 'string') return p;
    if (typeof opts.storePath === 'string') {
      return join(dirname(opts.storePath), 'github-prs.json');
    }
  }
  return defaultPrStorePath();
}

export function loadPrStore(path = defaultPrStorePath()) {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
  } catch {
    return {};
  }
}

export function savePrStore(store, path = defaultPrStorePath()) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    throw new Error('savePrStore requires a store object');
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n');
  return store;
}

function prKey(repo, prNumber) {
  return `${repo}#${String(prNumber)}`;
}

function isRepoKnown(repo, installPath) {
  const store = loadStore(installPath);
  return Object.values(store).some(
    (r) => r && typeof r === 'object' && Array.isArray(r.repos) && r.repos.includes(repo),
  );
}

// Link a repo to an existing installation (tenant scope). Unknown
// installationId throws (fail closed). Idempotent: relinking appends no
// duplicate. Emits one `integration.changed` audit event per call.
export function selectRepo(installationId, repoFullName, opts) {
  if (installationId === undefined || installationId === null || installationId === '') {
    throw new Error('selectRepo requires installationId');
  }
  if (typeof repoFullName !== 'string' || repoFullName.trim() === '') {
    throw new Error('selectRepo requires repoFullName');
  }
  const storePath = resolveInstallPath(opts);
  const store = loadStore(storePath);
  const key = String(installationId);
  const record = store[key] || null;
  if (!record) {
    throw new Error(`selectRepo unknown installation (${key})`);
  }
  if (!Array.isArray(record.repos)) record.repos = [];
  if (!record.repos.includes(repoFullName)) record.repos.push(repoFullName);
  store[key] = record;
  saveStore(store, storePath);
  append('integration.changed', {
    actor: 'github-app',
    reason: `repo:selected:${key}:${repoFullName}`,
  });
  return record;
}

// Ingest a PR snapshot. Malformed SHAs throw (fail closed, before any
// repo check). Unknown repos return { ignored: true }. Same-headSha
// redelivery returns the stored record unchanged (no duplicates, no new
// event). A new headSha updates the record and emits one
// `verdict-invalidated` event — the old verdict is never silently kept.
export function ingestPR(input, opts) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('ingestPR requires {repo, prNumber, headSha, baseSha}');
  }
  const { repo, prNumber, headSha, baseSha } = input;
  if (typeof repo !== 'string' || repo.trim() === '') {
    throw new Error('ingestPR requires repo');
  }
  if (prNumber === undefined || prNumber === null || prNumber === '') {
    throw new Error('ingestPR requires prNumber');
  }
  requireSha('headSha', headSha);
  requireSha('baseSha', baseSha);
  const installPath = resolveInstallPath(opts);
  if (!isRepoKnown(repo, installPath)) return { ignored: true };
  const prPath = resolvePrPath(opts);
  const prs = loadPrStore(prPath);
  const key = prKey(repo, prNumber);
  const prev = prs[key] || null;
  if (prev && prev.headSha === headSha) return prev;
  const record = { repo, prNumber, headSha, baseSha, ingestedAt: new Date().toISOString() };
  prs[key] = record;
  savePrStore(prs, prPath);
  if (prev) {
    append('verdict-invalidated', {
      from: prev.headSha,
      to: headSha,
      actor: 'github-app',
      reason: `pr:head-moved:${repo}#${String(prNumber)}:${prev.headSha}->${headSha}`,
    });
  } else {
    append('pr.ingested', {
      actor: 'github-app',
      reason: `pr:ingested:${repo}#${String(prNumber)}:${headSha}`,
    });
  }
  return record;
}

// Return the stored headSha for a repo+PR, or null when nothing ingested.
export function captureHead(repo, prNumber, opts) {
  if (typeof repo !== 'string' || repo.trim() === '') {
    throw new Error('captureHead requires repo');
  }
  if (prNumber === undefined || prNumber === null || prNumber === '') {
    throw new Error('captureHead requires prNumber');
  }
  const rec = loadPrStore(resolvePrPath(opts))[prKey(repo, prNumber)] || null;
  return rec ? rec.headSha : null;
}
