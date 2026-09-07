// Evidence persistence — file-backed JSON store for sealed EvidenceItems.
//
// Closes the in-memory-only gap: sealed items (lib/evidence.js) are
// persisted by content-addressed id across processes.
//
// Validation is fail-closed: put() requires a frozen item whose id ===
// outputHash === hashBody() recomputed over the canonical body fields
// (runId, targetSha, type, command, exitCode, result, artifactRefs).
// Any tampered or unsealed item throws; nothing is persisted and no
// audit event is emitted on rejection.
//
// State shape (single JSON file):
//   { items: [EvidenceItem, ...] }
//
// Persistence mirrors lib/org-store.js: atomic write (tmp file +
// rename), load on construct. A missing file yields an empty store; a
// corrupt file (unparseable JSON or wrong shape) throws fail-closed —
// never silently reset. NOTE: load does NOT hash-validate entries;
// hash inventory is verifyAll()'s job (inventory, not gate), so a
// hand-corrupted entry still loads and is reported by verifyAll().
//
// Every successful put appends one audit event (evidence.stored).
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { append } from './audit.js';
import { hashBody } from './evidence.js';

function requireFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('createEvidenceStore requires filePath');
  }
  return filePath;
}

function bodyOf(item) {
  return {
    runId: item.runId ?? null,
    targetSha: item.targetSha ?? null,
    type: item.type ?? null,
    command: item.command ?? null,
    exitCode: item.exitCode ?? null,
    result: item.result ?? null,
    artifactRefs: Array.isArray(item.artifactRefs) ? [...item.artifactRefs] : item.artifactRefs,
  };
}

function recomputedHash(item) {
  return hashBody(bodyOf(item));
}

function assertSealed(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('evidence-store: put requires a sealed EvidenceItem');
  }
  if (!Object.isFrozen(item)) {
    throw new Error('evidence-store: reject unsealed evidence (item must be frozen)');
  }
  if (typeof item.id !== 'string' || item.id === '') {
    throw new Error('evidence-store: reject unsealed evidence (missing id)');
  }
  if (typeof item.outputHash !== 'string' || item.outputHash === '') {
    throw new Error('evidence-store: reject unsealed evidence (missing outputHash)');
  }
  if (!Array.isArray(item.artifactRefs) || !Object.isFrozen(item.artifactRefs)) {
    throw new Error('evidence-store: reject unsealed evidence (artifactRefs must be a frozen array)');
  }
  if (item.id !== item.outputHash) {
    throw new Error(`evidence-store: reject tampered evidence (${item.id}): id !== outputHash`);
  }
  let recomputed;
  try {
    recomputed = recomputedHash(item);
  } catch {
    throw new Error(`evidence-store: reject tampered evidence (${item.id}): cannot recompute outputHash`);
  }
  if (recomputed !== item.outputHash) {
    throw new Error(`evidence-store: reject tampered evidence (${item.id}): outputHash mismatch`);
  }
}

function freezeItem(raw) {
  const artifactRefs = Array.isArray(raw.artifactRefs)
    ? Object.freeze([...raw.artifactRefs])
    : raw.artifactRefs;
  return Object.freeze({ ...raw, artifactRefs });
}

function loadFile(filePath) {
  if (!existsSync(filePath)) return { items: [] };
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`evidence-store: cannot read store file (${filePath}): ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`evidence-store: corrupt store file (${filePath}): invalid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`evidence-store: corrupt store file (${filePath}): expected an object`);
  }
  const items = parsed.items === undefined ? [] : parsed.items;
  if (!Array.isArray(items)) {
    throw new Error(`evidence-store: corrupt store file (${filePath}): "items" must be an array`);
  }
  for (const entry of items) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`evidence-store: corrupt store file (${filePath}): "items" holds a non-object entry`);
    }
  }
  return { items: items.map(freezeItem) };
}

function persist(filePath, state) {
  mkdirSync(dirname(filePath), { recursive: true });
  // Uniquely-named tmp: no predictable sibling for symlink games, no partial.
  const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, filePath);
}

export function createEvidenceStore(filePath) {
  requireFilePath(filePath);
  let state = loadFile(filePath);
  const save = () => persist(filePath, state);

  const store = {
    filePath,

    reload() {
      state = loadFile(filePath);
      return true;
    },

    put(item) {
      assertSealed(item);
      const stored = freezeItem({ ...item });
      const idx = state.items.findIndex((e) => e.id === stored.id);
      if (idx === -1) state.items.push(stored);
      else state.items[idx] = stored;
      save();
      append('evidence.stored', {
        findingId: null,
        from: stored.targetSha ?? null,
        to: stored.id,
        actor: 'evidence-store',
        reason: `evidence:stored:${stored.id}`,
      });
      return stored;
    },

    get(id) {
      if (typeof id !== 'string' || id === '') return null;
      return state.items.find((e) => e.id === id) || null;
    },

    listByRun(runId) {
      return state.items.filter((e) => e.runId === runId);
    },

    listByTarget(targetSha) {
      return state.items.filter((e) => e.targetSha === targetSha);
    },

    // Inventory, not gate: revalidates every stored item's hash chain
    // and reports bad ids without throwing.
    verifyAll() {
      const bad = [];
      for (const entry of state.items) {
        let valid = false;
        try {
          valid =
            !!entry &&
            typeof entry === 'object' &&
            typeof entry.id === 'string' &&
            entry.id === entry.outputHash &&
            Array.isArray(entry.artifactRefs) &&
            recomputedHash(entry) === entry.outputHash;
        } catch {
          valid = false;
        }
        if (!valid) bad.push(entry && typeof entry.id === 'string' ? entry.id : String(entry?.id));
      }
      return { ok: bad.length === 0, checked: state.items.length, bad };
    },
  };

  return store;
}
