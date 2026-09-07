import { parseDiff } from './_diff-parse.js';

// Narrow list-route check: a route whose path names a collection
// (list/search/items, or plural /users) only fires when the hunk carries
// no pagination keyword at all. Keyword absence is file-scoped, so a
// `limit` helper elsewhere in the same file still counts as paginated.
const JS_PATH_RE = /\.(m?js|ts|cjs|mjs)$/;
const SKIP_PATH_RE = /test|spec|__tests__|fixture/i;
const LIST_ROUTE_RE = /\b(app|router|server)\.(get|post)\s*\(\s*['"][^'"]*(\/list|\/search|\/items|users|orders|products|events)['"][^)]*\)/;
const PAGINATION_RE = /\b(limit|offset|page|perPage|per_page|first|take|cursor)\b/;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!JS_PATH_RE.test(f.path)) continue;
    if (SKIP_PATH_RE.test(f.path)) continue;
    const allText = f.addedLines.map((l) => l.text).join('\n');
    if (PAGINATION_RE.test(allText)) continue;
    for (const added of f.addedLines) {
      if (LIST_ROUTE_RE.test(added.text)) {
        findings.push({
          ruleId: 'no-unbounded-list-query-without-pagination',
          file: f.path,
          line: added.line,
          evidence: added.text.trim()
        });
        break;
      }
    }
  }
  return findings;
}
