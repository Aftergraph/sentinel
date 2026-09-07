import { parseDiff } from './_diff-parse.js';

const SKIP_PATH_RE = /test|spec|__tests__|fixture/i;
const LOCALHOST_RE = /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/;

function isComment(t) {
  const s = t.trim();
  return s.startsWith('//') || s.startsWith('*') || s.startsWith('#') || s.startsWith('<!--');
}

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (SKIP_PATH_RE.test(f.path)) continue;
    for (const added of f.addedLines) {
      if (isComment(added.text)) continue;
      if (LOCALHOST_RE.test(added.text)) {
        findings.push({
          ruleId: 'no-hardcoded-localhost-url-in-diff',
          file: f.path,
          line: added.line,
          evidence: added.text.trim()
        });
      }
    }
  }
  return findings;
}
