import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const GITHUB_EVIDENCE_CONTRACT = 'sentinel.github-evidence/1.0';
export const GITHUB_EVIDENCE_STATES = Object.freeze([
  'REVIEWED',
  'WORKFLOWS_VERIFIED',
  'VERIFIED_EVIDENCE_PACK',
]);

const INPUT_FIELDS = new Set([
  'repo',
  'prNumber',
  'headSha',
  'baseSha',
  'installationId',
  'rulePackVersion',
  'policyHash',
  'receiptId',
  'state',
  'workflowEvidence',
  'evidencePackId',
  'executionProvenance',
]);

const HEX40_OR_64 = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const HEX64 = /^[0-9a-f]{64}$/;

function assertString(name, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`github evidence requires ${name}`);
  }
  return value;
}

function assertSha(name, value) {
  if (typeof value !== 'string' || !HEX40_OR_64.test(value)) {
    throw new Error(`github evidence requires immutable ${name}`);
  }
  return value;
}

function canonicalWorkflowEvidence(list, headSha) {
  if (!Array.isArray(list)) throw new Error('github evidence requires workflowEvidence array');
  return list.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`github evidence workflow evidence[${i}] must be an object`);
    }
    const keys = Object.keys(item).sort();
    const allowed = ['conclusion', 'headSha', 'name', 'runId'];
    if (JSON.stringify(keys) !== JSON.stringify(allowed)) {
      throw new Error(`github evidence workflow evidence[${i}] has unknown fields`);
    }
    const name = assertString(`workflowEvidence[${i}].name`, item.name);
    if ((!Number.isInteger(item.runId) && typeof item.runId !== 'string') || String(item.runId).trim() === '') {
      throw new Error(`github evidence requires workflowEvidence[${i}].runId`);
    }
    if (item.conclusion !== 'success') {
      throw new Error(`github evidence requires successful workflow evidence (got ${String(item.conclusion)})`);
    }
    const itemHead = assertSha(`workflowEvidence[${i}].headSha`, item.headSha);
    if (itemHead !== headSha) {
      throw new Error(`github evidence workflow evidence[${i}] head does not match envelope HEAD`);
    }
    return Object.freeze({
      name,
      runId: item.runId,
      conclusion: 'success',
      headSha: itemHead,
    });
  });
}

function canonicalExecutionProvenance(value) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('github evidence executionProvenance must be an object');
  }
  const keys = Object.keys(value).sort();
  const allowed = [
    'branchHash',
    'branchId',
    'lineageHash',
    'routingDecisionHash',
    'workId',
    'worksEvidenceHash',
  ];
  if (JSON.stringify(keys) !== JSON.stringify(allowed)) {
    throw new Error('github evidence executionProvenance has unknown or missing fields');
  }
  const branchId = assertString('executionProvenance.branchId', value.branchId);
  const workId = assertString('executionProvenance.workId', value.workId);
  for (const [name, hash] of [
    ['routingDecisionHash', value.routingDecisionHash],
    ['branchHash', value.branchHash],
    ['lineageHash', value.lineageHash],
    ['worksEvidenceHash', value.worksEvidenceHash],
  ]) {
    if (typeof hash !== 'string' || !HEX64.test(hash)) {
      throw new Error(`github evidence executionProvenance.${name} must be 64-hex sha256`);
    }
  }
  return Object.freeze({
    routingDecisionHash: value.routingDecisionHash,
    branchId,
    branchHash: value.branchHash,
    lineageHash: value.lineageHash,
    workId,
    worksEvidenceHash: value.worksEvidenceHash,
  });
}

function canonicalBody(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('github evidence requires an object');
  }
  for (const key of Object.keys(input)) {
    if (!INPUT_FIELDS.has(key)) throw new Error(`github evidence unknown field: ${key}`);
  }

  const repo = assertString('repo', input.repo);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('github evidence requires repo owner/name');
  }
  if (!Number.isInteger(input.prNumber) || input.prNumber < 1) {
    throw new Error('github evidence requires positive prNumber');
  }
  const headSha = assertSha('headSha', input.headSha);
  const baseSha = assertSha('baseSha', input.baseSha);
  if ((!Number.isInteger(input.installationId) && typeof input.installationId !== 'string') ||
      String(input.installationId).trim() === '') {
    throw new Error('github evidence requires installationId');
  }
  const rulePackVersion = assertString('rulePackVersion', input.rulePackVersion);
  const receiptId = assertString('receiptId', input.receiptId);
  if (!HEX64.test(receiptId)) throw new Error('github evidence requires 64-hex receiptId');
  if (!GITHUB_EVIDENCE_STATES.includes(input.state)) {
    throw new Error(`github evidence invalid state: ${String(input.state)}`);
  }

  const workflowEvidence = canonicalWorkflowEvidence(input.workflowEvidence ?? [], headSha);
  if (input.state !== 'REVIEWED' && workflowEvidence.length === 0) {
    throw new Error(`github evidence state ${input.state} requires workflow evidence`);
  }

  let evidencePackId = input.evidencePackId ?? null;
  if (input.state === 'VERIFIED_EVIDENCE_PACK') {
    if (typeof evidencePackId !== 'string' || !/^evp_[a-f0-9]{64}$/.test(evidencePackId)) {
      throw new Error('github evidence VERIFIED_EVIDENCE_PACK requires evidence pack id');
    }
  } else if (evidencePackId !== null) {
    throw new Error(`github evidence state ${input.state} cannot claim an evidence pack`);
  }

  const executionProvenance = canonicalExecutionProvenance(input.executionProvenance);
  if (executionProvenance !== null && input.state !== 'VERIFIED_EVIDENCE_PACK') {
    throw new Error(`github evidence state ${input.state} cannot claim execution provenance`);
  }

  const policyHash = input.policyHash ?? null;
  if (policyHash !== null && (typeof policyHash !== 'string' || policyHash.trim() === '')) {
    throw new Error('github evidence policyHash must be null or non-empty string');
  }

  return Object.freeze({
    contract: GITHUB_EVIDENCE_CONTRACT,
    repo,
    prNumber: input.prNumber,
    headSha,
    baseSha,
    installationId: input.installationId,
    rulePackVersion,
    policyHash,
    receiptId,
    state: input.state,
    workflowEvidence: Object.freeze(workflowEvidence),
    evidencePackId,
    ...(executionProvenance === null ? {} : { executionProvenance }),
  });
}

function bodyHash(body) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function requireSigningKey(signingKey) {
  if (typeof signingKey !== 'string' || signingKey.length < 8) {
    throw new Error('github evidence requires signing key (fail closed)');
  }
  return signingKey;
}

function signatureFor(evidenceId, signingKey) {
  return 'hmac-sha256:' + createHmac('sha256', requireSigningKey(signingKey))
    .update(evidenceId)
    .digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function makeGitHubEvidence(input, { signingKey } = {}) {
  const body = canonicalBody(input);
  const evidenceId = 'sge_' + bodyHash(body);
  return Object.freeze({
    ...body,
    evidence_id: evidenceId,
    signature: signatureFor(evidenceId, signingKey),
  });
}

export function verifyGitHubEvidence(envelope, { signingKey } = {}) {
  try {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return { valid: false, reason: 'not an object' };
    }
    const {
      contract,
      evidence_id: evidenceId,
      signature,
      ...input
    } = envelope;
    if (contract !== GITHUB_EVIDENCE_CONTRACT) {
      return { valid: false, reason: 'unknown contract' };
    }
    const body = canonicalBody(input);
    const expectedId = 'sge_' + bodyHash(body);
    if (!safeEqual(evidenceId, expectedId)) {
      return { valid: false, reason: 'evidence_id mismatch' };
    }
    const expectedSignature = signatureFor(expectedId, signingKey);
    if (!safeEqual(signature, expectedSignature)) {
      return { valid: false, reason: 'signature mismatch' };
    }
    return { valid: true };
  } catch (err) {
    return { valid: false, reason: err.message };
  }
}
