import { parseDiff } from './_diff-parse.js';

const SKIP_PATH_RE = /test|spec|__tests__|fixture/i;
const TLS_OFF_RE = /NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*['"]?0['"]?/;
const REJECT_UNAUTH_FALSE_RE = /rejectUnauthorized\s*:\s*false/;
const STRICT_SSL_FALSE_RE = /strictSSL\s*:\s*false/;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (SKIP_PATH_RE.test(f.path)) continue;
    for (const added of f.addedLines) {
      if (TLS_OFF_RE.test(added.text) || REJECT_UNAUTH_FALSE_RE.test(added.text) || STRICT_SSL_FALSE_RE.test(added.text)) {
        findings.push({
          ruleId: 'no-disabled-tls-verification',
          file: f.path,
          line: added.line,
          evidence: added.text.trim()
        });
      }
    }
  }
  return findings;
}
