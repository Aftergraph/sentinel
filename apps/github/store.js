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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { append } from '../../lib/audit.js';

export function defaultStorePath() {
  return join(homedir(), '.sentinel', 'github-installations.json');
}

// Load the store object (key -> record). Missing file yields an empty
// store; a corrupt or non-object file yields an empty store rather than
// failing the webhook path (payload validation still fails closed).
export function loadStore(path = defaultStorePath()) {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
  } catch {
    return {};
  }
}

export function saveStore(store, path = defaultStorePath()) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    throw new Error('saveStore requires a store object');
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n');
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
