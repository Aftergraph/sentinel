import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export function defaultDeliveryStorePath() {
  return join(homedir(), '.sentinel', 'github-deliveries.json');
}

const ALLOWED = Object.freeze({
  pull_request: new Set(['opened', 'synchronize', 'reopened']),
  workflow_run: new Set(['completed']),
  installation: new Set(['created', 'deleted', 'suspend', 'unsuspend', 'new_permissions_accepted']),
  installation_repositories: new Set(['added', 'removed']),
  ping: new Set(['']),
});

function load(path) {
  if (!existsSync(path)) return {};
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`delivery store corrupt (${path}): ${err.message}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`delivery store corrupt (${path}): not an object`);
  }
  return doc;
}

function save(path, doc) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  renameSync(tmp, path);
}

function canonical(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('delivery provenance requires an object');
  }
  const { deliveryId, event, action = '', installationId, repository, headSha = null } = input;
  if (typeof deliveryId !== 'string' || deliveryId.trim() === '') {
    throw new Error('delivery provenance requires deliveryId');
  }
  if (!Object.hasOwn(ALLOWED, event)) {
    throw new Error(`GitHub event not allowed: ${event}`);
  }
  if (!ALLOWED[event].has(action || '')) {
    throw new Error(`GitHub action not allowed for ${event}: ${action}`);
  }
  if (event !== 'ping') {
    if (installationId === undefined || installationId === null || installationId === '') {
      throw new Error('delivery provenance requires installationId');
    }
  }
  if (event === 'pull_request' || event === 'workflow_run') {
    if (typeof repository !== 'string' || repository.trim() === '') {
      throw new Error('delivery provenance requires repository');
    }
  }
  if (headSha !== null && !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(headSha)) {
    throw new Error('delivery provenance headSha must be immutable Git SHA');
  }
  return Object.freeze({
    deliveryId,
    event,
    action: action || '',
    installationId: installationId ?? null,
    repository: repository ?? null,
    headSha,
  });
}

export function createDeliveryStore({ path } = {}) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error('delivery store requires path');
  }
  return Object.freeze({
    claim(input) {
      const provenance = canonical(input);
      const doc = load(path);
      const existing = doc[provenance.deliveryId];
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(provenance)) {
          throw new Error(`conflicting replay for delivery ${provenance.deliveryId} (fail closed)`);
        }
        return { duplicate: true, provenance: Object.freeze({ ...existing }) };
      }
      doc[provenance.deliveryId] = provenance;
      save(path, doc);
      return { duplicate: false, provenance };
    },
  });
}
