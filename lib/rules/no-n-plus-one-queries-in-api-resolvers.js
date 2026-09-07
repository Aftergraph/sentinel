import { parseDiff } from './_diff-parse.js';

const JS_PATH_RE = /\.(m?js|ts|cjs)$/;
const SKIP_PATH_RE = /test|spec|__tests__|fixture/i;
const LOOP_RE = /\b(for|forEach|map|while)\s*[\(\{<]|for\s*\(/;

// Commented-out code is not shipped code (adversarial waves 20-23): a
// comment describing a query shape must never fire the rule itself.
function isComment(t) {
  const s = t.trim();
  return s.startsWith('//') || s.startsWith('*') || s.startsWith('#') || s.startsWith('<!--');
}
// Method-style query verbs must be CALLS (open paren): a property access like
// `rec.findings` is data, not a query. Bare engine tokens (knex, sql`, .run()
// keep their existing shapes.
const QUERY_RE = /\.(find|findOne|findById|findAll|query|select|execute)\s*\(|prisma\.\w+\.find|db\.\w+\.find|knex|sql`|\.run\(/i;

export function check(diffText) {
  const findings = [];
  const files = parseDiff(diffText);
  for (const f of files) {
    if (!JS_PATH_RE.test(f.path)) continue;
    if (SKIP_PATH_RE.test(f.path)) continue;
    // Sliding window: if a query call appears within N lines of a loop opener, flag it.
    // The window includes the opener's own line: single-line `map`/`for`
    // queries (`ids.map((id) => db.users.find(id))`) are the same bug shape.
    const added = f.addedLines;
    for (let i = 0; i < added.length; i++) {
      if (isComment(added[i].text)) continue;
      if (LOOP_RE.test(added[i].text)) {
        const windowEnd = Math.min(added.length, i + 15);
        for (let j = i; j < windowEnd; j++) {
          if (isComment(added[j].text)) continue;
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
