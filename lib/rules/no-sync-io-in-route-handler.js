import { parseDiff } from './_diff-parse.js';

// Sync I/O only fires inside request-serving files (route/server/handler/
// controller/resolver/api). The same call in scripts/migrations is out of
// scope by design — this is what keeps precision high.
const JS_PATH_RE = /\.(m?js|ts|cjs|mjs)$/;
const SCOPE_RE = /(route|server|handler|controller|resolver|middleware|api)/i;
const SKIP_PATH_RE = /test|spec|__tests__|fixture/i;
const SYNC_RE = /\b(fs\.(readFileSync|writeFileSync|readdirSync|statSync)|child_process\.\w*Sync|execSync|spawnSync)\b/;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!JS_PATH_RE.test(f.path)) continue;
    if (!SCOPE_RE.test(f.path)) continue;
    if (SKIP_PATH_RE.test(f.path)) continue;
    for (const added of f.addedLines) {
      if (SYNC_RE.test(added.text)) {
        findings.push({
          ruleId: 'no-sync-io-in-route-handler',
          file: f.path,
          line: added.line,
          evidence: added.text.trim()
        });
      }
    }
  }
  return findings;
}
