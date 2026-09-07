import { parseDiff } from './_diff-parse.js';

const JS_PATH_RE = /\.(m?js|ts|cjs|mjs)$/;
const SKIP_PATH_RE = /test|spec|__tests__|fixture/i;
const EVAL_RE = /\beval\s*\(/;
const NEW_FUNCTION_RE = /\bnew\s+Function\s*\(/;

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
      if (EVAL_RE.test(added.text) || NEW_FUNCTION_RE.test(added.text)) {
        findings.push({
          ruleId: 'no-eval-with-dynamic-input',
          file: f.path,
          line: added.line,
          evidence: added.text.trim()
        });
      }
    }
  }
  return findings;
}
