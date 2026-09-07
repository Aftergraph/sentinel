import { parseDiff } from './_diff-parse.js';

const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    for (const added of f.addedLines) {
      if (PEM_RE.test(added.text)) {
        findings.push({
          ruleId: 'no-private-key-in-diff',
          file: f.path,
          line: added.line,
          evidence: 'PEM private key material added'
        });
      }
    }
  }
  return findings;
}
