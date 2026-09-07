import { parseDiff } from './_diff-parse.js';

const SQL_PATH_RE = /\b(migrations?|db|schema)\b.*\.(sql)$/i;
const DESTRUCTIVE_RE = /\b(DROP\s+(TABLE|COLUMN)|TRUNCATE(\s+TABLE)?)\b/i;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!SQL_PATH_RE.test(f.path)) continue;
    for (const added of f.addedLines) {
      if (DESTRUCTIVE_RE.test(added.text)) {
        findings.push({
          ruleId: 'no-destructive-sql-without-guard',
          file: f.path,
          line: added.line,
          evidence: added.text.trim()
        });
      }
    }
  }
  return findings;
}
