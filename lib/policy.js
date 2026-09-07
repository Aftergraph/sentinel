// Policy engine MVP — versioned verification policies (fail closed).
//
// Contract:
//   parsePolicy(yamlText) -> versioned policy object (throws on malformed).
//   resolvePolicy(policies, { repo, path }) -> most-specific matching policy.
//   evaluatePolicy(policy, { findings, checks, headSha, version }) ->
//     { allowed, verdict, reasons, policyVersion } + exactly one audit event.
//
// Zero-dep (node:crypto + local modules only), pure except for the single
// audit append per evaluation. No network.

import { createHash } from 'node:crypto';
import { SEVERITY_MAP } from './rulepack.js';
import { append } from './audit.js';

export const POLICY_API_VERSION = 'sentinel.aftergraph/v1';
export const POLICY_KIND = 'VerificationPolicy';

// Every severity the rulepack can produce; policy blocking_severity must be
// a subset of this (unknown severities are malformed, never ignored).
export const KNOWN_SEVERITIES = new Set(Object.values(SEVERITY_MAP));

// ---------------------------------------------------------------------------
// Minimal YAML subset parser (block maps + scalar-string lists only).
// Supports `key: value`, nested `key:` blocks, `- item` lists, quoted
// scalars, and inline `[]`. Anything else (tabs, flow maps, lists of maps)
// throws — a policy we cannot parse exactly must never silently weaken.
// ---------------------------------------------------------------------------

function stripComment(content) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble) {
      const prev = content[i - 1];
      if (prev === undefined || prev === ' ' || prev === '\t') return content.slice(0, i);
    }
  }
  return content;
}

// Index of the `key:` colon (colon outside quotes followed by space/end).
function splitKey(content) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === ':' && !inSingle && !inDouble) {
      const next = content[i + 1];
      if (next === undefined || next === ' ' || next === '\t') return i;
    }
  }
  return -1;
}

function parseScalar(raw, line) {
  const s = raw.trim();
  if (s === '[]') return [];
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  if (s.startsWith('"') || s.startsWith("'") || s.startsWith('{') || (s.startsWith('['))) {
    throw new Error(`Invalid policy: bad scalar (line ${line})`);
  }
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function parseMiniYaml(text) {
  const items = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const lineNo = idx + 1;
    const lead = raw.match(/^[ ]*/)[0];
    if (/^\s*$/.test(raw)) return;
    if (raw.startsWith('\t') || (lead.length < raw.length && raw[lead.length] !== ' ' && /^\t/.test(raw.slice(lead.length)))) {
      throw new Error(`Invalid policy: tabs not allowed (line ${lineNo})`);
    }
    if (raw.match(/^[ \t]*\t/)) throw new Error(`Invalid policy: tabs not allowed (line ${lineNo})`);
    const indent = lead.length;
    let content = stripComment(raw.slice(indent)).trim();
    if (content === '' || content.startsWith('#')) return;
    items.push({ indent, content, line: lineNo });
  });
  if (items.length === 0) throw new Error('Invalid policy: empty document');
  let pos = 0;

  function parseMap(indent) {
    const obj = {};
    while (pos < items.length) {
      const it = items[pos];
      if (it.indent < indent) break;
      if (it.indent > indent) throw new Error(`Invalid policy: bad indentation (line ${it.line})`);
      if (it.content === '-' || it.content.startsWith('- ')) {
        throw new Error(`Invalid policy: unexpected list item (line ${it.line})`);
      }
      const colon = splitKey(it.content);
      if (colon < 0) throw new Error(`Invalid policy: expected 'key: value' (line ${it.line})`);
      const key = it.content.slice(0, colon).trim();
      if (!key || /\s/.test(key)) throw new Error(`Invalid policy: bad key (line ${it.line})`);
      if (Object.hasOwn(obj, key)) throw new Error(`Invalid policy: duplicate key "${key}" (line ${it.line})`);
      const rest = it.content.slice(colon + 1).trim();
      pos++;
      if (rest !== '') {
        obj[key] = parseScalar(rest, it.line);
      } else if (pos < items.length && items[pos].indent > it.indent) {
        const next = items[pos];
        obj[key] = (next.content === '-' || next.content.startsWith('- '))
          ? parseList(next.indent)
          : parseMap(next.indent);
      } else {
        obj[key] = null;
      }
    }
    return obj;
  }

  function parseList(indent) {
    const arr = [];
    while (pos < items.length) {
      const it = items[pos];
      if (it.indent < indent) break;
      if (it.indent > indent) throw new Error(`Invalid policy: bad indentation (line ${it.line})`);
      if (!(it.content === '-' || it.content.startsWith('- '))) break;
      const rest = it.content === '-' ? '' : it.content.slice(2).trim();
      if (rest === '') throw new Error(`Invalid policy: empty list item (line ${it.line})`);
      if (splitKey(rest) >= 0) throw new Error(`Invalid policy: lists of maps are not supported (line ${it.line})`);
      arr.push(parseScalar(rest, it.line));
      pos++;
    }
    return arr;
  }

  const root = parseMap(items[0].indent);
  if (pos < items.length) throw new Error(`Invalid policy: bad indentation (line ${items[pos].line})`);
  return root;
}

// ---------------------------------------------------------------------------
// Validation (fail closed: any shape violation throws with a reason).
// ---------------------------------------------------------------------------

function fail(reason) {
  throw new Error(`Invalid policy: ${reason}`);
}

function stringArray(value, field) {
  if (!Array.isArray(value)) fail(`"${field}" must be an array`);
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) fail(`"${field}" must be an array of non-empty strings`);
  }
  return value;
}

function validatePolicyDoc(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('document must be a mapping');
  if (doc.apiVersion !== POLICY_API_VERSION) fail(`apiVersion must equal '${POLICY_API_VERSION}'`);
  if (doc.kind !== POLICY_KIND) fail(`kind must equal '${POLICY_KIND}'`);
  if (!doc.metadata || typeof doc.metadata !== 'object' || Array.isArray(doc.metadata)) fail('"metadata" must be a mapping');
  if (typeof doc.metadata.name !== 'string' || doc.metadata.name.length === 0) fail('"metadata.name" must be a non-empty string');
  if (!doc.spec || typeof doc.spec !== 'object' || Array.isArray(doc.spec)) fail('"spec" must be a mapping');

  const allowedSpec = new Set(['scope', 'required', 'blocking_severity', 'approvals']);
  for (const k of Object.keys(doc.spec)) {
    if (!allowedSpec.has(k)) fail(`unknown spec key "${k}"`);
  }

  const scope = doc.spec.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) fail('"spec.scope" must be a mapping');
  for (const k of Object.keys(scope)) {
    if (k !== 'repo' && k !== 'paths') fail(`unknown spec.scope key "${k}"`);
  }
  let repo = null;
  if (scope.repo !== undefined && scope.repo !== null) {
    if (typeof scope.repo !== 'string' || scope.repo.length === 0) fail('"spec.scope.repo" must be a non-empty string or absent (org-wide)');
    repo = scope.repo;
  }
  if (!Array.isArray(scope.paths)) fail('"spec.scope.paths" must be an array of globs');
  const paths = stringArray(scope.paths, 'spec.scope.paths');

  const required = doc.spec.required === undefined ? fail('"spec.required" is required') : stringArray(doc.spec.required, 'spec.required');

  if (!Array.isArray(doc.spec.blocking_severity)) fail('"spec.blocking_severity" must be an array of known severities');
  const blocking = stringArray(doc.spec.blocking_severity, 'spec.blocking_severity');
  for (const sev of blocking) {
    if (!KNOWN_SEVERITIES.has(sev)) fail(`unknown severity "${sev}" in "spec.blocking_severity" (known: ${[...KNOWN_SEVERITIES].sort().join(', ')})`);
  }

  const approvals = doc.spec.approvals;
  if (!approvals || typeof approvals !== 'object' || Array.isArray(approvals)) fail('"spec.approvals" must be a mapping');
  for (const k of Object.keys(approvals)) {
    if (k !== 'required') fail(`unknown spec.approvals key "${k}"`);
  }
  if (!Array.isArray(approvals.required)) fail('"spec.approvals.required" must be an array of names');
  const approvalNames = stringArray(approvals.required, 'spec.approvals.required');

  return {
    apiVersion: doc.apiVersion,
    kind: doc.kind,
    metadata: { name: doc.metadata.name },
    spec: {
      scope: { repo, paths },
      required,
      blocking_severity: blocking,
      approvals: { required: approvalNames },
    },
  };
}

// ---------------------------------------------------------------------------
// Content addressing: policyVersion pins name + content hash into verdicts.
// ---------------------------------------------------------------------------

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function policyVersion(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('Invalid policy: cannot version a non-object');
  }
  const name = policy.metadata?.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Invalid policy: "metadata.name" must be a non-empty string');
  }
  if (!policy.spec || typeof policy.spec !== 'object') throw new Error('Invalid policy: "spec" must be a mapping');
  const content = {
    apiVersion: policy.apiVersion,
    kind: policy.kind,
    metadata: { name },
    spec: {
      scope: policy.spec.scope,
      required: policy.spec.required,
      blocking_severity: policy.spec.blocking_severity ?? policy.spec.blockingSeverity,
      approvals: policy.spec.approvals,
    },
  };
  const hash = createHash('sha256').update(stableStringify(content)).digest('hex').slice(0, 16);
  return `${name}@${hash}`;
}

export function parsePolicy(yamlText) {
  if (typeof yamlText !== 'string' || yamlText.trim() === '') fail('input must be a non-empty string');
  const policy = validatePolicyDoc(parseMiniYaml(yamlText));
  policy.policyVersion = policyVersion(policy);
  return policy;
}

// ---------------------------------------------------------------------------
// Scope resolution: most-specific match wins (longest path prefix;
// repo-scoped beats org-wide at equal prefix; pathless = repo/org default).
// ---------------------------------------------------------------------------

function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/, '\\$&');
    }
  }
  return new RegExp(`${out}$`);
}

function literalPrefixLength(glob) {
  const m = glob.search(/[*?[]/);
  return m < 0 ? glob.length : m;
}

function matchScore(policy, repo, path) {
  const scope = policy?.spec?.scope;
  if (!scope || typeof scope !== 'object') return null;
  if (scope.repo != null && scope.repo !== repo) return null;
  const paths = Array.isArray(scope.paths) ? scope.paths : [];
  if (paths.length === 0) return { prefixLen: -1, repoScoped: scope.repo != null ? 1 : 0 };
  if (typeof path !== 'string' || path.length === 0) return null;
  let best = -1;
  for (const pattern of paths) {
    if (typeof pattern !== 'string' || pattern.length === 0) continue;
    if (globToRegExp(pattern).test(path)) {
      best = Math.max(best, literalPrefixLength(pattern));
    }
  }
  return best < 0 ? null : { prefixLen: best, repoScoped: scope.repo != null ? 1 : 0 };
}

export function resolvePolicy(policies, { repo, path } = {}) {
  if (!Array.isArray(policies) || policies.length === 0) {
    throw new Error('No matching policy: empty policy set');
  }
  if (typeof repo !== 'string' || repo.length === 0) {
    throw new Error('No matching policy: "repo" must be a non-empty string');
  }
  let winner = null;
  let winnerScore = null;
  for (const policy of policies) {
    const score = matchScore(policy, repo, path);
    if (!score) continue;
    if (
      !winnerScore ||
      score.prefixLen > winnerScore.prefixLen ||
      (score.prefixLen === winnerScore.prefixLen && score.repoScoped > winnerScore.repoScoped)
    ) {
      winner = policy;
      winnerScore = score;
    }
  }
  if (!winner) throw new Error(`No matching policy for repo "${repo}"${path ? ` path "${path}"` : ''}`);
  return winner;
}

// ---------------------------------------------------------------------------
// Evaluation: BLOCKED (required checks lack results) > DO_NOT_SHIP
// (in-scope finding with blocking severity, or a required check that ran
// and failed) > SHIP. Exactly one audit event per evaluation.
// (Approval enforcement is upstream: evaluatePolicy takes no approval
// evidence, so spec.approvals shapes parsing but not the verdict.)
// ---------------------------------------------------------------------------

const FAILURE_TOKENS = new Set(['failed', 'failure', 'fail', 'error', 'errored']);

function failureToken(value) {
  if (typeof value === 'string') return FAILURE_TOKENS.has(value.toLowerCase());
  if (value && typeof value === 'object') {
    return failureToken(value.status ?? value.result ?? value.state ?? '');
  }
  return false;
}

function lookupCheck(checks, name) {
  if (Array.isArray(checks)) {
    for (const item of checks) {
      if (typeof item === 'string') {
        if (item === name) return { present: true, failed: false };
      } else if (item && typeof item === 'object') {
        const itemName = item.type ?? item.name ?? item.check;
        if (itemName === name) {
          return {
            present: true,
            failed: item.passed === false || item.ok === false || item.success === false ||
              failureToken(item.status ?? item.result ?? item.state),
          };
        }
      }
    }
    return { present: false, failed: false };
  }
  if (checks && typeof checks === 'object') {
    if (!Object.hasOwn(checks, name)) return { present: false, failed: false };
    const value = checks[name];
    if (value === undefined || value === null) return { present: false, failed: false };
    return {
      present: true,
      failed: value === false || failureToken(value) ||
        (typeof value === 'object' && (value.passed === false || value.ok === false || value.success === false)),
    };
  }
  return { present: false, failed: false };
}

function findingSeverity(finding) {
  if (typeof finding?.severity === 'string') return finding.severity;
  return SEVERITY_MAP[finding?.ruleId] || 'security';
}

function findingPath(finding) {
  const p = finding?.file ?? finding?.path;
  return typeof p === 'string' && p.length > 0 ? p : null;
}

function inScope(policy, finding) {
  const paths = policy.spec.scope.paths;
  if (!paths || paths.length === 0) return true;
  const file = findingPath(finding);
  if (!file) return true; // fail closed: unlocatable findings stay in scope
  return paths.some((pattern) => globToRegExp(pattern).test(file));
}

export function evaluatePolicy(policy, { findings = [], checks = {}, headSha = 'unknown', version = null } = {}) {
  if (!policy || typeof policy !== 'object' || !policy.spec || typeof policy.spec !== 'object') {
    throw new Error('Invalid policy: evaluation requires a parsed policy object');
  }
  if (typeof policy.metadata?.name !== 'string' || policy.metadata.name.length === 0) {
    throw new Error('Invalid policy: "metadata.name" must be a non-empty string');
  }
  const required = Array.isArray(policy.spec.required) ? policy.spec.required : [];
  const blocking = new Set(policy.spec.blocking_severity ?? policy.spec.blockingSeverity ?? []);
  const list = Array.isArray(findings) ? findings : [];

  const missing = required.filter((name) => !lookupCheck(checks, name).present);
  let verdict;
  let reasons;
  if (missing.length > 0) {
    verdict = 'BLOCKED';
    reasons = missing.map((name) => `missing required check: "${name}"`);
  } else {
    const failed = required.filter((name) => lookupCheck(checks, name).failed);
    const blockingFindings = list.filter((f) => inScope(policy, f) && blocking.has(findingSeverity(f)));
    if (failed.length > 0) {
      verdict = 'DO_NOT_SHIP';
      reasons = failed.map((name) => `required check "${name}" failed`);
    } else if (blockingFindings.length > 0) {
      verdict = 'DO_NOT_SHIP';
      reasons = blockingFindings.map((f) => {
        const where = findingPath(f) ?? '(unknown file)';
        return `blocking finding: ${where} [${findingSeverity(f)}] ${f.ruleId ?? 'unknown-rule'}`;
      });
    } else {
      verdict = 'SHIP';
      reasons = [`clean: ${list.length} finding(s) reviewed, ${required.length} required check(s) satisfied`];
    }
  }

  const versioned = policyVersion(policy);
  const detail = reasons.join('; ');
  append('policy.evaluated', {
    actor: 'policy-engine',
    to: verdict,
    reason: `policy ${versioned} head ${headSha}${version ? ` version ${version}` : ''}: ${verdict} — ${detail}`,
  });

  return { allowed: verdict === 'SHIP', verdict, reasons, policyVersion: versioned };
}
