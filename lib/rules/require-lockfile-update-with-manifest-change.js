import { parseDiff } from './_diff-parse.js';

// Multi-file rule: a manifest change without its lockfile is a finding.
// Pure function of the file list in the diff — no filesystem access.
// Only dependency-section edits need a lockfile: scripts-only changes on a
// zero-dep manifest must not fire (dogfood wave-17: own package.json test
// script edit with no lockfile tracked).
const MANIFEST_RE = /(^|\/)package\.json$/;
const LOCK_RE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)$/;
const DEPS_KEY_RE = /"(dependencies|devDependencies|peerDependencies|optionalDependencies|overrides|resolutions)"\s*:/;

export function check(diffText) {
  const files = parseDiff(diffText);
  const hasLock = files.some((f) => LOCK_RE.test(f.path) && f.addedLines.length > 0);
  const findings = [];
  for (const manifest of files.filter((f) => MANIFEST_RE.test(f.path) && f.addedLines.length > 0)) {
    const touchesDeps = manifest.addedLines.some((l) => DEPS_KEY_RE.test(l.text));
    if (!touchesDeps) continue;
    if (hasLock) continue;
    const first = manifest.addedLines[0];
    findings.push({
      ruleId: 'require-lockfile-update-with-manifest-change',
      file: manifest.path,
      line: first.line,
      evidence: 'package.json changed without lockfile update'
    });
  }
  return findings;
}
