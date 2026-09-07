import { parseDiff } from './_diff-parse.js';

// Immediate retry without backoff: a single-line `.catch()` whose callback
// re-invokes the failed call with no delay primitive on the line. Hammering
// a failing endpoint in a hot loop turns a transient blip into a
// self-inflicted outage (precision-audit gap #8).
//
// Narrow by design (same shape as the migration backup-reference hatch):
//   - callback body must be a bare re-invocation call (fetch/axios/HTTP
//     verbs, or an explicit retry/reconnect/runner verb);
//   - any delay token on the same line (setTimeout, sleep, backoff,
//     retryAfter, ...) is an escape hatch and silences the finding;
//   - `.catch(() => ({}))`-style fallback values never match (no call);
//   - test/spec/fixture files and bin/ CLI entrypoints are out of scope.
const JS_PATH_RE = /\.(m?js|ts|cjs|mjs)$/;
const SKIP_PATH_RE = /test|spec|__tests__|fixture/i;
const ENTRYPOINT_RE = /(^|\/)bin\//;
const VERB = '(?:fetch|axios\\.\\w+|retry\\w*|reconnect\\w*|run|main|connect)';
const RECALL_RE = new RegExp(
  `\\.catch\\s*\\(\\s*(?:(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>\\s*${VERB}\\s*\\(|${VERB}\\s*[,)])`
);
const DELAY_RE = /setTimeout|setInterval|setImmediate|queueMicrotask|sleep|delay|backoff|retryAfter|waitFor|429/;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!JS_PATH_RE.test(f.path)) continue;
    if (SKIP_PATH_RE.test(f.path)) continue;
    if (ENTRYPOINT_RE.test(f.path)) continue;
    for (const added of f.addedLines) {
      if (!RECALL_RE.test(added.text)) continue;
      if (DELAY_RE.test(added.text)) continue;
      findings.push({
        ruleId: 'require-retry-with-backoff-for-transient-failures',
        file: f.path,
        line: added.line,
        evidence: added.text.trim()
      });
    }
  }
  return findings;
}
