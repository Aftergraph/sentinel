import { parseDiff } from './_diff-parse.js';

const JS_PATH_RE = /\.(m?js|ts|cjs)$/;
const SKIP_PATH_RE = /test|spec|__tests__|fixture/i;
const RESOLVER_RE = /\b(resolve|resolver|fieldResolver|\w+:\s*(async\s+)?\()/;
const NESTED_FETCH_RE = /\.(find|findOne|findById|findAll|query|get|load|prisma\.\w+\.find)/i;
const SAFE_RE = /\b(DataLoader|dataloader|eager|include|withRelated|preload|batchLoad)\b/i;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!JS_PATH_RE.test(f.path)) continue;
    if (SKIP_PATH_RE.test(f.path)) continue;
    
    // Check if entire file has DataLoader/eager patterns
    const allText = f.addedLines.map(l => l.text).join('\n');
    const hasSafePattern = SAFE_RE.test(allText);
    
    const added = f.addedLines;
    for (let i = 0; i < added.length; i++) {
      if (RESOLVER_RE.test(added[i].text)) {
        const windowEnd = Math.min(added.length, i + 20);
        let sawFetch = false;
        let fetchLine = null;
        for (let j = i; j < windowEnd; j++) {
          if (!sawFetch && NESTED_FETCH_RE.test(added[j].text)) {
            sawFetch = true;
            fetchLine = added[j];
          }
        }
        if (sawFetch && !hasSafePattern) {
          findings.push({
            ruleId: 'require-dataloader-or-eager-load-for-nested-fetches',
            file: f.path,
            line: fetchLine.line,
            evidence: fetchLine.text.trim()
          });
        }
      }
    }
  }
  return findings;
}
