import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

const STATES = new Set(['AVAILABLE', 'DEGRADED', 'UNAVAILABLE', 'STALE', 'REVOKED']);

function requirePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('capability-attestation-store: filePath required');
  }
  return filePath;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isoTime(value) {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

export function validateCapabilityAttestation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [
    'capability',
    'freshnessTtlMs',
    'id',
    'nodeId',
    'observedAt',
    'source',
    'state',
    'verifiedAt',
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) return false;
  if (
    !nonEmpty(value.id) ||
    !nonEmpty(value.nodeId) ||
    !nonEmpty(value.capability) ||
    !STATES.has(value.state) ||
    !isoTime(value.observedAt) ||
    !isoTime(value.verifiedAt) ||
    !Number.isInteger(value.freshnessTtlMs) ||
    value.freshnessTtlMs <= 0 ||
    !nonEmpty(value.source)
  ) return false;
  if (Date.parse(value.observedAt) > Date.parse(value.verifiedAt)) return false;
  return true;
}

function freeze(value) {
  const cloned = structuredClone(value);
  return Object.freeze(cloned);
}

function loadFile(filePath) {
  if (!existsSync(filePath)) return { attestations: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error(`capability-attestation-store: corrupt store file (${filePath})`);
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !Array.isArray(parsed.attestations)
  ) {
    throw new Error(`capability-attestation-store: corrupt store file (${filePath})`);
  }
  for (const attestation of parsed.attestations) {
    if (!validateCapabilityAttestation(attestation)) {
      throw new Error(`capability-attestation-store: invalid stored attestation (${filePath})`);
    }
  }
  return { attestations: parsed.attestations.map(freeze) };
}

function persist(filePath, state) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, filePath);
}

export function freshnessState(attestation, nowMs = Date.now()) {
  if (!validateCapabilityAttestation(attestation)) {
    throw new Error('capability-attestation-store: invalid attestation');
  }
  if (attestation.state === 'REVOKED' || attestation.state === 'STALE') {
    return attestation.state;
  }
  const expiresAt = Date.parse(attestation.verifiedAt) + attestation.freshnessTtlMs;
  return nowMs > expiresAt ? 'STALE' : attestation.state;
}

export function createCapabilityAttestationStore(filePath) {
  requirePath(filePath);
  let state = loadFile(filePath);

  return {
    filePath,
    reload() {
      state = loadFile(filePath);
      return true;
    },
    put(attestation) {
      if (!validateCapabilityAttestation(attestation)) {
        throw new Error('capability-attestation-store: invalid attestation');
      }
      const stored = freeze(attestation);
      const index = state.attestations.findIndex((item) => item.id === stored.id);
      state = {
        attestations:
          index === -1
            ? [...state.attestations, stored]
            : state.attestations.map((item, i) => (i === index ? stored : item)),
      };
      persist(filePath, state);
      return stored;
    },
    query({ nodeIds, capabilities, nowMs = Date.now() }) {
      const nodes = new Set(nodeIds);
      const caps = new Set(capabilities);
      return state.attestations
        .filter((item) => nodes.has(item.nodeId) && caps.has(item.capability))
        .map((item) => ({
          ...item,
          state: freshnessState(item, nowMs),
        }))
        .sort((a, b) =>
          a.nodeId.localeCompare(b.nodeId) ||
          a.capability.localeCompare(b.capability) ||
          a.id.localeCompare(b.id),
        );
    },
  };
}
