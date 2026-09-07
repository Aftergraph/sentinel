// Sealed evidence — ENGINE S2.
//
// sealEvidence() snapshots one verification execution into a frozen,
// content-addressed EvidenceItem. outputHash is the sha256 of the canonical
// JSON of every field except id/sealedAt, and id IS that hash — so identical
// inputs always seal to the identical item. The item (and its artifactRefs
// array) is Object.frozen: any post-seal mutation throws.
//
// attachEvidence() binds a sealed item to a finding. It throws with code
// INVALID_VERIFICATION when the evidence targetSha does not match the
// finding's pinned targetSha, and otherwise appends the evidence id to
// finding.evidenceRefs plus one audit event (lib/audit.js).

import { createHash } from 'node:crypto';
import { append } from './audit.js';

// Canonical JSON: recursively sort object keys so the hash is stable
// regardless of input key insertion order.
function canonicalize(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function hashBody(body) {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export function sealEvidence({
  runId = null,
  targetSha = null,
  type = null,
  command = null,
  exitCode = null,
  result = null,
  artifacts = [],
} = {}) {
  const artifactRefs = Object.freeze([...(artifacts ?? [])]);
  const body = { runId, targetSha, type, command, exitCode, result, artifactRefs };
  const outputHash = hashBody(body);
  return Object.freeze({
    id: outputHash,
    ...body,
    outputHash,
    sealedAt: new Date().toISOString(),
  });
}

export function attachEvidence(finding, evidence, { actor = 'human' } = {}) {
  if (!finding || typeof finding !== 'object') throw new Error('attachEvidence requires a finding');
  if (!evidence || typeof evidence !== 'object' || !evidence.id) {
    throw new Error('attachEvidence requires sealed evidence');
  }
  if (finding.targetSha !== evidence.targetSha) {
    const err = new Error(
      `INVALID_VERIFICATION: evidence targetSha (${evidence.targetSha}) does not match finding targetSha (${finding.targetSha})`,
    );
    err.code = 'INVALID_VERIFICATION';
    throw err;
  }
  const refs = Array.isArray(finding.evidenceRefs) ? finding.evidenceRefs : [];
  finding.evidenceRefs = [...refs, evidence.id];
  append('evidence', {
    findingId: finding.id ?? null,
    from: finding.targetSha ?? null,
    to: evidence.id,
    actor,
    reason: null,
  });
  return finding;
}
