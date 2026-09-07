// SentinelBench runner (Team B): deterministic rule-pack scoring over
// file-referenced cases. Pure counts only — no LLM, no timing, no network.
// A case hits iff every expected rule fires AND no unexpected rule fires
// (strict). Cases may opt out with "strict": false + "reason" (recall-only);
// the runner itself is never weakened to make a pack pass.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeDiff } from '../lib/review.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function resolveDiffFile(diffFile, casesDir) {
  if (isAbsolute(diffFile)) return diffFile;
  return resolve(REPO_ROOT, diffFile);
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

export async function runBench({ pack, casesDir }) {
  const files = readdirSync(casesDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const results = [];
  let truePositives = 0;
  let falsePositivesTotal = 0;
  let expectedTotal = 0;
  let firedTotal = 0;
  const rulesFired = {};
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(casesDir, file), 'utf8'));
    const name = raw.name || file.replace(/\.json$/, '');
    const expected = [...new Set(raw.expect || [])].sort();
    const strict = raw.strict !== false;
    const diffText = readFileSync(resolveDiffFile(raw.diffFile, casesDir), 'utf8');
    const { result } = await analyzeDiff({
      diffText,
      pack,
      headSha: `bench-${name}`,
      baseSha: 'bench-base',
    });
    const fired = [...new Set(
      [...result.blocking, ...(result.nonBlocking || [])].map((f) => f.ruleId)
    )].sort();
    const firedSet = new Set(fired);
    const expectedSet = new Set(expected);
    const missing = expected.filter((id) => !firedSet.has(id));
    const falsePositives = fired.filter((id) => !expectedSet.has(id));
    const hit = strict
      ? missing.length === 0 && falsePositives.length === 0
      : missing.length === 0;
    truePositives += expected.length - missing.length;
    falsePositivesTotal += falsePositives.length;
    expectedTotal += expected.length;
    firedTotal += fired.length;
    for (const id of fired) rulesFired[id] = (rulesFired[id] || 0) + 1;
    results.push({
      case: name,
      fired,
      expected,
      hit,
      strict,
      ...(raw.reason ? { reason: raw.reason } : {}),
      falsePositives,
      missing,
    });
  }
  const cases = results.length;
  return {
    results,
    metrics: {
      recall: expectedTotal === 0 ? 1 : round4(truePositives / expectedTotal),
      precision: firedTotal === 0 ? 1 : round4(truePositives / firedTotal),
      fpPerCase: cases === 0 ? 0 : round4(falsePositivesTotal / cases),
      cases,
      rulesFired,
    },
  };
}
