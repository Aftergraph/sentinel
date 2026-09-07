import { parseDiff } from './_diff-parse.js';

// Related-table columns without a foreign-key constraint admit orphaned
// rows that corrupt referential integrity (precision-audit gap #14).
//
// Schema-aware, same-file shaped (not cross-repo absence): a migration
// that ADDS a `*_id` column of a reference-like type (INT/INTEGER/
// BIGINT/NUMERIC/UUID) but adds NO `REFERENCES` / `FOREIGN KEY` in the
// same file's added lines fires on the column line.
//
// Deliberate scoping (precision over recall):
//   - commented lines are not code (wave-22 isSqlComment);
//   - a `REFERENCES`/`FOREIGN KEY` anywhere in the file's added lines is
//     the escape hatch (constraint may attach to another column);
//   - files adding a `*_type` column are skipped: polymorphic
//     associations (`*_id` + `*_type`) legitimately carry no FK;
//   - bare `id` (no `_id` suffix) never matches — surrogate primary keys
//     are not references.
const SQL_PATH_RE = /\b(migrations?|db|schema)\b.*\.(sql)$/i;
const REF_COL_RE = /\b([a-zA-Z_][\w$]*_id)\b\s+(BIGINT|INTEGER|INT|SMALLINT|NUMERIC|UUID)\b/i;
const FK_RE = /\b(REFERENCES|FOREIGN\s+KEY)\b/i;
const POLYMORPHIC_RE = /\b[a-zA-Z_][\w$]*_type\b/i;

function isSqlComment(t) {
  const s = t.trim();
  return s.startsWith('--') || s.startsWith('#') || s.startsWith('/*') || s.startsWith('*');
}

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!SQL_PATH_RE.test(f.path)) continue;
    if (f.addedLines.length === 0) continue;
    const code = f.addedLines.filter((l) => !isSqlComment(l.text));
    if (code.some((l) => POLYMORPHIC_RE.test(l.text))) continue;
    if (code.some((l) => FK_RE.test(l.text))) continue;
    for (const added of code) {
      const m = added.text.match(REF_COL_RE);
      if (!m) continue;
      findings.push({
        ruleId: 'require-foreign-key-constraints-on-related-tables',
        file: f.path,
        line: added.line,
        evidence: added.text.trim()
      });
    }
  }
  return findings;
}
