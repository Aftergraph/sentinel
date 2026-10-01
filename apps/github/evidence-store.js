import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

import { verifyGitHubEvidence } from './evidence.js';

function requirePath(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('github evidence store requires file path');
  }
  return filePath;
}

function load(filePath) {
  if (!existsSync(filePath)) return { items: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`github evidence store: corrupt store file (${filePath}): ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.items)) {
    throw new Error(`github evidence store: corrupt store file (${filePath}): expected {items:[]}`);
  }
  for (const item of parsed.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.evidence_id !== 'string') {
      throw new Error(`github evidence store: corrupt store file (${filePath}): invalid item`);
    }
  }
  return { items: parsed.items.map((x) => Object.freeze({ ...x })) };
}

function persist(filePath, state) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, filePath);
}

export function createGitHubEvidenceStore(filePath, { signingKey } = {}) {
  requirePath(filePath);
  let state = load(filePath);

  return Object.freeze({
    put(envelope) {
      const verified = verifyGitHubEvidence(envelope, { signingKey });
      if (!verified.valid) {
        throw new Error(`invalid evidence: ${verified.reason || 'verification failed'}`);
      }
      const stored = Object.freeze({ ...envelope });
      const idx = state.items.findIndex((x) => x.evidence_id === stored.evidence_id);
      if (idx >= 0) {
        if (JSON.stringify(state.items[idx]) !== JSON.stringify(stored)) {
          throw new Error(`invalid evidence: conflicting content for ${stored.evidence_id}`);
        }
      } else {
        state = { items: [...state.items, stored] };
        persist(filePath, state);
      }
      return stored;
    },

    get(id) {
      if (typeof id !== 'string' || id === '') return null;
      return state.items.find((x) => x.evidence_id === id) || null;
    },

    list() {
      return [...state.items];
    },

    reload() {
      state = load(filePath);
      return true;
    },
  });
}
