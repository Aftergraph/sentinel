// Resolution memory: append-only JSONL at ~/.sentinel/resolutions.jsonl.
// Match key: ruleId + file + fingerprint(evidence). Memory carries across HEADs.
// ponytail: fingerprint = trimmed evidence string. Good enough for deterministic
// rule output; upgrade to hash if evidence ever gets noisy/long.

import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export function defaultPath() {
  return join(homedir(), '.sentinel', 'resolutions.jsonl');
}

export function fingerprint(evidence) {
  return createHash('sha256').update(String(evidence || '')).digest('hex').slice(0, 16);
}

export function keyOf(finding) {
  return `${finding.ruleId}\t${finding.file}\t${fingerprint(finding.evidence)}`;
}

export function load(path = defaultPath()) {
  if (!existsSync(path)) return new Set();
  const text = readFileSync(path, 'utf8');
  const set = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && rec.ruleId && rec.file) {
        const fp = rec.fingerprint || fingerprint(rec.evidence || '');
        set.add(`${rec.ruleId}\t${rec.file}\t${fp}`);
      }
    } catch {
      // ponytail: skip malformed lines rather than fail the run.
    }
  }
  return set;
}

export function append(resolution, path = defaultPath()) {
  const dir = join(path, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const rec = {
    ruleId: resolution.ruleId,
    file: resolution.file,
    fingerprint: fingerprint(resolution.evidence || ''),
    evidence: resolution.evidence,
    resolvingHeadSha: resolution.resolvingHeadSha || null,
    resolvedAt: new Date().toISOString(),
    reason: resolution.reason || 'manual'
  };
  appendFileSync(path, JSON.stringify(rec) + '\n');
  return rec;
}

export function isSilenced(finding, resolutions) {
  return resolutions.has(keyOf(finding));
}

export function partition(findings, resolutions) {
  const blocking = [];
  const silenced = [];
  for (const f of findings) {
    if (isSilenced(f, resolutions)) silenced.push(f);
    else blocking.push(f);
  }
  return { blocking, silenced };
}
