import { parseDiff } from './_diff-parse.js';

const SQL_PATH_RE = /\b(migrations?|db|schema)\b.*\.(sql)$/i;
const BEGIN_RE = /\bBEGIN\b/i;
const COMMIT_RE = /\bCOMMIT\b/i;
const ROLLBACK_RE = /\bROLLBACK\b/i;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!SQL_PATH_RE.test(f.path)) continue;
    const addedText = f.addedLines.map(l => l.text).join('\n');
    const hasBegin = BEGIN_RE.test(addedText);
    const hasCommit = COMMIT_RE.test(addedText);
    const hasRollback = ROLLBACK_RE.test(addedText);
    if (hasBegin && hasCommit && !hasRollback) {
      const beginLine = f.addedLines.find(l => BEGIN_RE.test(l.text));
      findings.push({
        ruleId: 'require-transaction-rollback-on-failure',
        file: f.path,
        line: beginLine ? beginLine.line : f.addedLines[0].line,
        evidence: 'BEGIN/COMMIT without ROLLBACK block'
      });
    }
  }
  return findings;
}
