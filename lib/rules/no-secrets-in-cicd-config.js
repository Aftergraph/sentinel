import { parseDiff } from './_diff-parse.js';

const WF_PATH_RE = /\.github\/workflows\/.*\.(ya?ml)$/i;
const SECRET_RE = /(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)\s*[:=]\s*[^\s$\{][^\n]{2,}/i;
const SAFE_RE = /\$\{\{\s*(secrets|env|vars)\./;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!WF_PATH_RE.test(f.path)) continue;
    for (const added of f.addedLines) {
      if (SAFE_RE.test(added.text)) continue;
      if (SECRET_RE.test(added.text)) {
        findings.push({
          ruleId: 'no-secrets-in-cicd-config',
          file: f.path,
          line: added.line,
          evidence: added.text.trim()
        });
      }
    }
  }
  return findings;
}
