import { parseDiff } from './_diff-parse.js';

const SQL_PATH_RE = /\b(migrations?|db|schema)\b.*\.(sql)$/i;
const DESTRUCTIVE_RE = /\b(DROP\s+(TABLE|COLUMN)|TRUNCATE(\s+TABLE)?)\b/i;

// Commented-out SQL never executes (adversarial wave-22).
function isSqlComment(t) {
  const s = t.trim();
  return s.startsWith('--') || s.startsWith('#') || s.startsWith('/*') || s.startsWith('*');
}

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!SQL_PATH_RE.test(f.path)) continue;
    for (const added of f.addedLines) {
      if (isSqlComment(added.text)) continue;
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
