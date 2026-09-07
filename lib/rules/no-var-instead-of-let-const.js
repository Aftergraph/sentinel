import { parseDiff } from './_diff-parse.js';

// Advisory only (style never blocks). Flags `var` declarations in
// non-test JS/TS diffs.
const JS_PATH_RE = /\.(m?js|ts|cjs|mjs)$/;
const SKIP_PATH_RE = /test|spec|__tests__|fixture/i;
const VAR_RE = /^\s*var\s+\w/;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!JS_PATH_RE.test(f.path)) continue;
    if (SKIP_PATH_RE.test(f.path)) continue;
    for (const added of f.addedLines) {
      if (VAR_RE.test(added.text)) {
        findings.push({
          ruleId: 'no-var-instead-of-let-const',
          file: f.path,
          line: added.line,
          evidence: added.text.trim()
        });
      }
    }
  }
  return findings;
}
