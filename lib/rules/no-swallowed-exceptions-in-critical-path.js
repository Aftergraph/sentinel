import { parseDiff } from './_diff-parse.js';

const JS_PATH_RE = /\.(mjs|cjs|js|ts|tsx|jsx)$/i;
// Empty catch: `catch (..) {}` with nothing but whitespace between braces,
// matched over the file's joined added text so multi-line empties count.
// ponytail: v0 heuristic — a catch containing only comments still fires.
// Distinguishing "logged then swallowed" from "documented intentional
// swallow" needs data-flow context this diff-level rule cannot see.
const EMPTY_CATCH_RE = /\bcatch\s*(\([^)]*\))?\s*\{\s*\}/g;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!JS_PATH_RE.test(f.path)) continue;
    const added = f.addedLines.map((l) => l.text).join('\n');
    let m;
    while ((m = EMPTY_CATCH_RE.exec(added)) !== null) {
      const upto = added.slice(0, m.index).split('\n').length;
      const base = f.addedLines.length > 0 ? f.addedLines[0].line : 1;
      findings.push({
        ruleId: 'no-swallowed-exceptions-in-critical-path',
        file: f.path,
        line: base + upto - 1,
        evidence: m[0].replace(/\s+/g, ' ').trim()
      });
    }
  }
  return findings;
}
