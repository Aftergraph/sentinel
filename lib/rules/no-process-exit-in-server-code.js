import { parseDiff } from './_diff-parse.js';

const JS_PATH_RE = /\.(m?js|ts|cjs|mjs)$/;
const SKIP_PATH_RE = /test|spec|__tests__|fixture/i;
// CLI entrypoints (bin/) are not server code: process.exit in a top-level
// CLI catch is the correct way to set the exit status (dogfood wave-17:
// own bin/sentinel.js strict-flag handler). lib/ stays covered — library
// code must use `process.exitCode` so importing servers stay alive.
const ENTRYPOINT_RE = /(^|\/)bin\//;

// Commented-out code never runs (adversarial wave-21).
function isComment(t) {
  const s = t.trim();
  return s.startsWith('//') || s.startsWith('*') || s.startsWith('#') || s.startsWith('<!--');
}
const EXIT_RE = /\bprocess\.exit\s*\(/;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!JS_PATH_RE.test(f.path)) continue;
    if (SKIP_PATH_RE.test(f.path)) continue;
    if (ENTRYPOINT_RE.test(f.path)) continue;
    for (const added of f.addedLines) {
      if (isComment(added.text)) continue;
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
