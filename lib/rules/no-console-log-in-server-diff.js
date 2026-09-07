import { parseDiff } from './_diff-parse.js';

// Advisory only (style never blocks). console.error/warn stay allowed for
// operational logging; raw console.log in shipped code is the signal.
const JS_PATH_RE = /\.(m?js|ts|cjs|mjs)$/;
const SKIP_PATH_RE = /test|spec|__tests__|fixture/i;
const LOG_RE = /\bconsole\.log\s*\(/;

// Commented-out code is not shipped code (adversarial wave-21).
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
      if (LOG_RE.test(added.text)) {
        findings.push({
          ruleId: 'no-console-log-in-server-diff',
          file: f.path,
          line: added.line,
          evidence: added.text.trim()
        });
      }
    }
  }
  return findings;
}
