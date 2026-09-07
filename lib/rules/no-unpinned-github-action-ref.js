import { parseDiff } from './_diff-parse.js';

// Flag `uses: <action>@<mutable-ref>` (tag/branch like v4, main, latest).
// Pinned 40-hex SHAs pass. Scoped to workflow files only.
const WF_PATH_RE = /\.github\/workflows\/.*\.(ya?ml)$/i;
const USES_RE = /uses:\s*([^\s#]+)@([^\s#]+)/;
const SHA_RE = /^[0-9a-f]{40}$/i;

// Commented-out workflow lines never execute (adversarial wave-23).
function isComment(t) {
  return t.trim().startsWith('#');
}

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!WF_PATH_RE.test(f.path)) continue;
    for (const added of f.addedLines) {
      if (isComment(added.text)) continue;
      const m = added.text.match(USES_RE);
      if (!m) continue;
      if (SHA_RE.test(m[2])) continue;
      findings.push({
        ruleId: 'no-unpinned-github-action-ref',
        file: f.path,
        line: added.line,
        evidence: added.text.trim()
      });
    }
  }
  return findings;
}
