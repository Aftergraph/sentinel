import { parseDiff } from './_diff-parse.js';

const ROUTE_RE = /\b(app|router|server)\.(get|post|put|patch|delete|use|all)\s*\(\s*['"][^'"]+['"]/;
const AUTH_RE = /\b(auth|requireAuth|isAuthenticated|authenticate|ensureAuth|withAuth|verifyToken|checkAuth|protect)\b/i;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!/\.(m?js|ts|cjs)$/.test(f.path)) continue;
    if (/test|spec|__tests__|fixture/i.test(f.path)) continue;
    for (const added of f.addedLines) {
      if (ROUTE_RE.test(added.text) && !AUTH_RE.test(added.text)) {
        findings.push({
          ruleId: 'no-unauthenticated-api-endpoints',
          file: f.path,
          line: added.line,
          evidence: added.text.trim()
        });
      }
    }
  }
  return findings;
}
