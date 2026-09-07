import { parseDiff } from './_diff-parse.js';

// Multi-file rule: a manifest change without its lockfile is a finding.
// Pure function of the file list in the diff — no filesystem access.
const MANIFEST_RE = /(^|\/)package\.json$/;
const LOCK_RE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/;

export function check(diffText) {
  const files = parseDiff(diffText);
  const manifest = files.find((f) => MANIFEST_RE.test(f.path) && f.addedLines.length > 0);
  if (!manifest) return [];
  const hasLock = files.some((f) => LOCK_RE.test(f.path) && f.addedLines.length > 0);
  if (hasLock) return [];
  const first = manifest.addedLines[0];
  return [{
    ruleId: 'require-lockfile-update-with-manifest-change',
    file: manifest.path,
    line: first.line,
    evidence: 'package.json changed without lockfile update'
  }];
}
