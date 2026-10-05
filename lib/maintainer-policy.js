// Governed autonomous-maintenance policy for Sentinel.
//
// This module intentionally does not execute Git/GitHub writes. It decides
// whether a finding may enter an autonomous remediation lane. Execution is
// owned by a separately-scoped maintainer worker; verification stays owned by
// Sentinel so the implementing actor never self-verifies.
//
// Fail-closed defaults:
// - unknown/malformed policy => throw
// - unknown severity/risk => BLOCKED
// - protected paths => BLOCKED
// - direct-to-main / direct-deploy are never policy outputs

const ACTIONS = Object.freeze({
  OBSERVE: 'OBSERVE',
  PROPOSE: 'PROPOSE',
  REMEDIATE_PR: 'REMEDIATE_PR',
  BLOCKED: 'BLOCKED',
});

const KNOWN_SEVERITIES = new Set([
  'security',
  'reliability',
  'correctness',
  'data',
  'performance',
  'style',
]);

const KNOWN_RISKS = new Set(['low', 'medium', 'high', 'critical']);

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid maintainer policy: ${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireStringArray(value, field) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
    throw new Error(`Invalid maintainer policy: ${field} must be an array of non-empty strings`);
  }
  return value.map((v) => v.trim());
}

function normalizePolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid maintainer policy: expected object');
  }

  const apiVersion = requireString(input.apiVersion, 'apiVersion');
  const kind = requireString(input.kind, 'kind');
  if (apiVersion !== 'sentinel.aftergraph/v1alpha1') {
    throw new Error('Invalid maintainer policy: unsupported apiVersion');
  }
  if (kind !== 'AutonomousMaintainerPolicy') {
    throw new Error('Invalid maintainer policy: unsupported kind');
  }

  const metadata = input.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Invalid maintainer policy: metadata is required');
  }

  const spec = input.spec;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('Invalid maintainer policy: spec is required');
  }

  const repo = requireString(spec.repo, 'spec.repo');
  const allowedSeverities = requireStringArray(spec.allowedSeverities, 'spec.allowedSeverities');
  for (const severity of allowedSeverities) {
    if (!KNOWN_SEVERITIES.has(severity)) {
      throw new Error(`Invalid maintainer policy: unknown severity ${severity}`);
    }
  }

  const maxRisk = requireString(spec.maxRisk, 'spec.maxRisk');
  if (!KNOWN_RISKS.has(maxRisk)) {
    throw new Error(`Invalid maintainer policy: unknown maxRisk ${maxRisk}`);
  }

  return Object.freeze({
    name: requireString(metadata.name, 'metadata.name'),
    repo,
    enabled: spec.enabled === true,
    allowedSeverities: Object.freeze([...allowedSeverities]),
    maxRisk,
    allowedPaths: Object.freeze(requireStringArray(spec.allowedPaths ?? ['**'], 'spec.allowedPaths')),
    protectedPaths: Object.freeze(requireStringArray(spec.protectedPaths ?? [], 'spec.protectedPaths')),
    requireExactHead: spec.requireExactHead !== false,
    requireSentinelVerification: spec.requireSentinelVerification !== false,
    requireIndependentChecks: Object.freeze(
      requireStringArray(spec.requireIndependentChecks ?? [], 'spec.requireIndependentChecks'),
    ),
    allowAutoMerge: spec.allowAutoMerge === true,
    allowDirectMain: false,
    allowDirectDeploy: false,
  });
}

function riskRank(risk) {
  return ['low', 'medium', 'high', 'critical'].indexOf(risk);
}

function escapeRegex(text) {
  return text.replace(/[|\\{}()[\]^$+?.]/g, '\\function globPrefix(pattern) {
  const index = pattern.search(/[?*[]{}]/);
  return index === -1 ? pattern : pattern.slice(0, index);
}

function matchesPath(path, patterns) {
  if (patterns.includes('**')) return true;
  return patterns.some((pattern) => {
    if (pattern === path) return true;
    const prefix = globPrefix(pattern);
    return prefix !== '' && path.startsWith(prefix);
  });
}');
}

function globToRegex(pattern) {
  // Maintainer policies only need path globs. Keep this deliberately small:
  // "*" matches within one path segment and "**" crosses directory boundaries.
  // Anchoring both ends avoids accidental prefix widening.
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
      continue;
    }
    source += escapeRegex(char);
  }
  return new RegExp(`^${source}// Governed autonomous-maintenance policy for Sentinel.
//
// This module intentionally does not execute Git/GitHub writes. It decides
// whether a finding may enter an autonomous remediation lane. Execution is
// owned by a separately-scoped maintainer worker; verification stays owned by
// Sentinel so the implementing actor never self-verifies.
//
// Fail-closed defaults:
// - unknown/malformed policy => throw
// - unknown severity/risk => BLOCKED
// - protected paths => BLOCKED
// - direct-to-main / direct-deploy are never policy outputs

const ACTIONS = Object.freeze({
  OBSERVE: 'OBSERVE',
  PROPOSE: 'PROPOSE',
  REMEDIATE_PR: 'REMEDIATE_PR',
  BLOCKED: 'BLOCKED',
});

const KNOWN_SEVERITIES = new Set([
  'security',
  'reliability',
  'correctness',
  'data',
  'performance',
  'style',
]);

const KNOWN_RISKS = new Set(['low', 'medium', 'high', 'critical']);

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid maintainer policy: ${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireStringArray(value, field) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.trim() === '')) {
    throw new Error(`Invalid maintainer policy: ${field} must be an array of non-empty strings`);
  }
  return value.map((v) => v.trim());
}

function normalizePolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid maintainer policy: expected object');
  }

  const apiVersion = requireString(input.apiVersion, 'apiVersion');
  const kind = requireString(input.kind, 'kind');
  if (apiVersion !== 'sentinel.aftergraph/v1alpha1') {
    throw new Error('Invalid maintainer policy: unsupported apiVersion');
  }
  if (kind !== 'AutonomousMaintainerPolicy') {
    throw new Error('Invalid maintainer policy: unsupported kind');
  }

  const metadata = input.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Invalid maintainer policy: metadata is required');
  }

  const spec = input.spec;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('Invalid maintainer policy: spec is required');
  }

  const repo = requireString(spec.repo, 'spec.repo');
  const allowedSeverities = requireStringArray(spec.allowedSeverities, 'spec.allowedSeverities');
  for (const severity of allowedSeverities) {
    if (!KNOWN_SEVERITIES.has(severity)) {
      throw new Error(`Invalid maintainer policy: unknown severity ${severity}`);
    }
  }

  const maxRisk = requireString(spec.maxRisk, 'spec.maxRisk');
  if (!KNOWN_RISKS.has(maxRisk)) {
    throw new Error(`Invalid maintainer policy: unknown maxRisk ${maxRisk}`);
  }

  return Object.freeze({
    name: requireString(metadata.name, 'metadata.name'),
    repo,
    enabled: spec.enabled === true,
    allowedSeverities: Object.freeze([...allowedSeverities]),
    maxRisk,
    allowedPaths: Object.freeze(requireStringArray(spec.allowedPaths ?? ['**'], 'spec.allowedPaths')),
    protectedPaths: Object.freeze(requireStringArray(spec.protectedPaths ?? [], 'spec.protectedPaths')),
    requireExactHead: spec.requireExactHead !== false,
    requireSentinelVerification: spec.requireSentinelVerification !== false,
    requireIndependentChecks: Object.freeze(
      requireStringArray(spec.requireIndependentChecks ?? [], 'spec.requireIndependentChecks'),
    ),
    allowAutoMerge: spec.allowAutoMerge === true,
    allowDirectMain: false,
    allowDirectDeploy: false,
  });
}

function riskRank(risk) {
  return ['low', 'medium', 'high', 'critical'].indexOf(risk);
}

);
}

function matchesPath(path, patterns) {
  if (typeof path !== 'string' || path === '') return false;
  return patterns.some((pattern) => globToRegex(pattern).test(path));
}

export function parseMaintainerPolicy(input) {
  return normalizePolicy(input);
}

export function evaluateMaintainerPolicy(policyInput, finding = {}) {
  const policy = normalizePolicy(policyInput);
  if (!policy.enabled) {
    return { action: ACTIONS.OBSERVE, reason: 'policy-disabled' };
  }

  if (finding.repo !== policy.repo) {
    return { action: ACTIONS.BLOCKED, reason: 'repo-mismatch' };
  }

  const severity = finding.severity;
  if (!KNOWN_SEVERITIES.has(severity)) {
    return { action: ACTIONS.BLOCKED, reason: 'unknown-severity' };
  }
  if (!policy.allowedSeverities.includes(severity)) {
    return { action: ACTIONS.PROPOSE, reason: 'severity-outside-autonomy' };
  }

  const risk = finding.risk;
  if (!KNOWN_RISKS.has(risk)) {
    return { action: ACTIONS.BLOCKED, reason: 'unknown-risk' };
  }
  if (riskRank(risk) > riskRank(policy.maxRisk)) {
    return { action: ACTIONS.PROPOSE, reason: 'risk-outside-autonomy' };
  }

  const paths = Array.isArray(finding.paths) ? finding.paths : [];
  if (paths.length === 0) {
    return { action: ACTIONS.BLOCKED, reason: 'missing-paths' };
  }
  if (paths.some((path) => matchesPath(path, policy.protectedPaths))) {
    return { action: ACTIONS.BLOCKED, reason: 'protected-path' };
  }
  if (paths.some((path) => !matchesPath(path, policy.allowedPaths))) {
    return { action: ACTIONS.PROPOSE, reason: 'path-outside-autonomy' };
  }

  if (policy.requireExactHead && finding.exactHead !== true) {
    return { action: ACTIONS.BLOCKED, reason: 'exact-head-required' };
  }

  if (policy.requireSentinelVerification && finding.sentinelVerified !== true) {
    return { action: ACTIONS.PROPOSE, reason: 'verification-required' };
  }

  const independent = new Set(Array.isArray(finding.passedChecks) ? finding.passedChecks : []);
  const missing = policy.requireIndependentChecks.filter((check) => !independent.has(check));
  if (missing.length > 0) {
    return { action: ACTIONS.PROPOSE, reason: 'independent-checks-required', missingChecks: missing };
  }

  return {
    action: ACTIONS.REMEDIATE_PR,
    reason: 'within-autonomy-envelope',
    autoMergeEligible: policy.allowAutoMerge,
    directMainAllowed: false,
    directDeployAllowed: false,
  };
}

export { ACTIONS };
