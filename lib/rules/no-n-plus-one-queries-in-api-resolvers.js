import { parseDiff } from './_diff-parse.js';

const JS_PATH_RE = /\.(m?js|ts|cjs)$/;
const SKIP_PATH_RE = /test|spec|__tests__|fixture/i;
const LOOP_RE = /\b(for|forEach|map|while)\s*[\(\{<]|for\s*\(/;
const QUERY_RE = /\.(find|findOne|findById|findAll|query|select|execute|prisma\.\w+\.find|db\.\w+\.find|knex|sql`|\.run\()/i;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!JS_PATH_RE.test(f.path)) continue;
    if (SKIP_PATH_RE.test(f.path)) continue;
    // Sliding window: if a query call appears within N lines of a loop opener, flag it.
    const added = f.addedLines;
    for (let i = 0; i < added.length; i++) {
      if (LOOP_RE.test(added[i].text)) {
        const windowEnd = Math.min(added.length, i + 15);
        for (let j = i + 1; j < windowEnd; j++) {
          if (QUERY_RE.test(added[j].text)) {
            findings.push({
              ruleId: 'no-n-plus-one-queries-in-api-resolvers',
              file: f.path,
              line: added[j].line,
              evidence: added[j].text.trim()
            });
            break;
          }
        }
      }
    }
  }
  return findings;
}
