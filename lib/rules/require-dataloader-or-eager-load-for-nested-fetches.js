import { parseDiff } from './_diff-parse.js';

const JS_PATH_RE = /\.(m?js|ts|cjs)$/;
const SKIP_PATH_RE = /test|spec|__tests__|fixture/i;
const RESOLVER_RE = /\b(resolve|resolver|fieldResolver|\w+:\s*(async\s+)?\()/;
const NESTED_FETCH_RE = /\.(find|findOne|findById|findAll|query|get|load|prisma\.\w+\.find)/i;
const SAFE_RE = /\b(DataLoader|dataloader|eager|include|withRelated|preload|batchLoad)\b/i;
// .get() on request accessors (URLSearchParams, headers, query objects, Maps)
// reads inbound request data — it is never a nested store fetch. Strip those
// before testing so `params.get('symbol')` in a handler cannot fire.
const ACCESSOR_GET_RE = /\b(params|searchParams|headers|query|cookies|url)\s*\.\s*get\s*\(/gi;

function isNestedFetch(line) {
  if (!NESTED_FETCH_RE.test(line)) return false;
  return NESTED_FETCH_RE.test(line.replace(ACCESSOR_GET_RE, ''));
}

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
          if (!sawFetch && isNestedFetch(added[j].text)) {
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
