import { parseDiff } from './_diff-parse.js';

// Loose equality is a merge-blocking correctness signal. `== null` is
// intentionally allowed (idiomatic null+undefined check). Comment lines
// and test files are out of scope.
const JS_PATH_RE = /\.(m?js|ts|cjs|mjs)$/;
const SKIP_PATH_RE = /test|spec|__tests__|fixture/i;
const LOOSE_EQ_RE = /(^|[^=!<>])==(?!=)/;
const LOOSE_NEQ_RE = /(^|[^=!<>])!=(?!=)/;
const NULL_OK_RE = /(==|!=)\s*null\b/;

function isComment(t) {
  const s = t.trim();
  return s.startsWith('//') || s.startsWith('*') || s.startsWith('#') || s.startsWith('<!--');
}

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!JS_PATH_RE.test(f.path)) continue;
    if (SKIP_PATH_RE.test(f.path)) continue;
    for (const added of f.addedLines) {
      if (isComment(added.text)) continue;
      if (NULL_OK_RE.test(added.text)) continue;
      if (LOOSE_EQ_RE.test(added.text) || LOOSE_NEQ_RE.test(added.text)) {
        findings.push({
          ruleId: 'require-strict-equality',
          file: f.path,
          line: added.line,
          evidence: added.text.trim()
        });
      }
    }
  }
  return findings;
}
