import { parseDiff } from './_diff-parse.js';

const SQL_PATH_RE = /\b(migrations?|db|schema)\b.*\.(sql)$/i;
const DESTRUCTIVE_RE = /\b(DROP\s+(COLUMN|TABLE)|TRUNCATE(\s+TABLE)?)\b/i;
const BACKUP_RE = /\b(backup|pg_dump|snapshot|restore\s+drill|runbook)\b/i;

// Flags destructive migration statements (DROP COLUMN/TABLE, TRUNCATE)
// in SQL migration files unless the same file's added lines reference a
// backup or restore drill.
// ponytail: per-file backup reference is a v0 heuristic — a comment can
// claim a backup that was never verified. A stronger gate would require
// a backup-manifest artifact link; that needs CI context this rule lacks.
export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!SQL_PATH_RE.test(f.path)) continue;
    const hasBackupRef = f.addedLines.some((l) => BACKUP_RE.test(l.text));
    if (hasBackupRef) continue;
    for (const added of f.addedLines) {
      if (DESTRUCTIVE_RE.test(added.text)) {
        findings.push({
          ruleId: 'no-destructive-migration-without-backup-verification',
          file: f.path,
          line: added.line,
          evidence: added.text.trim()
        });
      }
    }
  }
  return findings;
}
