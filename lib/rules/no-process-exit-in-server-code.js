import { parseDiff } from './_diff-parse.js';

const JS_PATH_RE = /\.(m?js|ts|cjs|mjs)$/;
const SKIP_PATH_RE = /test|spec|__tests__|fixture/i;
const EXIT_RE = /\bprocess\.exit\s*\(/;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!JS_PATH_RE.test(f.path)) continue;
    if (SKIP_PATH_RE.test(f.path)) continue;
    for (const added of f.addedLines) {
      if (EXIT_RE.test(added.text)) {
        findings.push({
          ruleId: 'no-process-exit-in-server-code',
          file: f.path,
          line: added.line,
          evidence: added.text.trim()
        });
      }
    }
  }
  return findings;
}
