import { parseDiff } from './_diff-parse.js';

// DELETE FROM / UPDATE ... SET without a WHERE clause. Because WHERE can
// legally sit on the next line, a statement opener only fires when no
// WHERE appears in the following 3 added lines.
const SQL_PATH_RE = /\b(migrations?|db|schema)\b.*\.(sql)$/i;
const DELETE_RE = /\bDELETE\s+FROM\b/i;
const UPDATE_RE = /\bUPDATE\b.+\bSET\b/i;
const WHERE_RE = /\bWHERE\b/i;

// Commented-out SQL never executes — and a commented WHERE guards
// nothing (adversarial wave-22: `-- WHERE id = 1` is not a guard).
function isSqlComment(t) {
  const s = t.trim();
  return s.startsWith('--') || s.startsWith('#') || s.startsWith('/*') || s.startsWith('*');
}

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!SQL_PATH_RE.test(f.path)) continue;
    const added = f.addedLines.filter((l) => !isSqlComment(l.text));
    for (let i = 0; i < added.length; i++) {
      const t = added[i].text;
      if (!DELETE_RE.test(t) && !UPDATE_RE.test(t)) continue;
      if (WHERE_RE.test(t)) continue;
      let guarded = false;
      for (let j = i + 1; j < Math.min(added.length, i + 4); j++) {
        if (WHERE_RE.test(added[j].text)) { guarded = true; break; }
      }
      if (!guarded) {
        findings.push({
          ruleId: 'require-where-on-delete-update',
          file: f.path,
          line: added[i].line,
          evidence: t.trim()
        });
      }
    }
  }
  return findings;
}
