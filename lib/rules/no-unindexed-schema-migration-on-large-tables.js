import { parseDiff } from './_diff-parse.js';

const SQL_PATH_RE = /\b(migrations?|db|schema)\b.*\.(sql)$/i;
const CREATE_INDEX_RE = /\bCREATE\s+INDEX\b(?!\s+CONCURRENTLY\b)/i;
const DROP_INDEX_RE = /\bDROP\s+INDEX\b(?!\s+CONCURRENTLY\b)/i;
const REINDEX_RE = /\bREINDEX\b(?!\s+CONCURRENTLY\b)/i;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!SQL_PATH_RE.test(f.path)) continue;
    for (const added of f.addedLines) {
      const t = added.text;
      if (CREATE_INDEX_RE.test(t) || DROP_INDEX_RE.test(t) || REINDEX_RE.test(t)) {
        findings.push({
          ruleId: 'no-unindexed-schema-migration-on-large-tables',
          file: f.path,
          line: added.line,
          evidence: added.text.trim()
        });
      }
    }
  }
  return findings;
}
