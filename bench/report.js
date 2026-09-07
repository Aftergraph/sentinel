// SentinelBench reporting: JSON artifact + human markdown.
// Pure renderers (testable) plus a thin CLI that writes bench/results.json
// and bench/REPORT.md. Exit 0 always on success — scores are data, and a
// low score must never break the build by itself.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBench } from './runner.js';
import { RULE_PACK_VERSION } from '../lib/rulepack.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Accepts either renderMarkdown(summary) or renderMarkdown({ pack, summary });
export function renderMarkdown(summaryOrEnvelope) {
  const { pack, summary } = (summaryOrEnvelope && 'metrics' in summaryOrEnvelope)
    ? { pack: summaryOrEnvelope.pack || RULE_PACK_VERSION, summary: summaryOrEnvelope }
    : summaryOrEnvelope;
  const m = summary.metrics;
  const lines = [];
  lines.push(`# SentinelBench report — pack \`${pack}\``);
  lines.push('');
  lines.push(`- cases: ${m.cases}`);
  lines.push(`- recall: ${m.recall}`);
  lines.push(`- precision: ${m.precision}`);
  lines.push(`- false positives per case: ${m.fpPerCase}`);
  const heldoutCount = summary.heldoutResults ? summary.heldoutResults.length : (summary.heldoutMetrics ? summary.heldoutMetrics.cases : 0);
  lines.push(`- held-out: ${heldoutCount} cases (excluded from main score)`);
  lines.push('');
  lines.push('| case | hit | strict | fired | expected |');
  lines.push('|---|---|---|---|---|');
  for (const r of summary.results) {
    lines.push(`| ${r.case} | ${r.hit ? 'yes' : 'NO'} | ${r.strict ? 'yes' : 'no'} | ${r.fired.join(', ') || '—'} | ${r.expected.join(', ') || '—'} |`);
  }
  const misses = summary.results.filter((r) => !r.hit);
  if (misses.length > 0) {
    lines.push('');
    lines.push('## Misses');
    for (const r of misses) {
      lines.push(`- ${r.case}: missing [${r.missing.join(', ') || '—'}], unexpected [${r.falsePositives.join(', ') || '—'}]${r.reason ? ` (${r.reason})` : ''}`);
    }
  }
  const heldout = summary.heldoutResults || [];
  if (heldout.length > 0) {
    lines.push('');
    lines.push('## Held-out (excluded from score)');
    lines.push('| case | hit | strict | fired | expected |');
    lines.push('|---|---|---|---|---|');
    for (const r of heldout) {
      lines.push(`| ${r.case} | ${r.hit ? 'yes' : 'NO'} | ${r.strict ? 'yes' : 'no'} | ${r.fired.join(', ') || '—'} | ${r.expected.join(', ') || '—'} |`);
    }
  }
  return lines.join('\n') + '\n';
}

export async function writeReport({ pack, casesDir, outDir }) {
  const summary = await runBench({ pack, casesDir });
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'results.json'), JSON.stringify({ pack, ...summary }, null, 2));
  writeFileSync(join(outDir, 'REPORT.md'), renderMarkdown({ pack, summary }));
  return summary;
}

const invoked = process.argv[1] && process.argv[1].endsWith('bench/report.js');
if (invoked) {
  const pack = process.argv[2] || RULE_PACK_VERSION;
  const summary = await writeReport({ pack, casesDir: join(HERE, 'cases'), outDir: HERE });
  const bad = summary.results.filter((r) => !r.hit).length;
  const heldoutCount = summary.heldoutResults ? summary.heldoutResults.length : 0;
  console.log(`bench: ${summary.metrics.cases} cases, recall ${summary.metrics.recall}, precision ${summary.metrics.precision} (${bad} miss${bad === 1 ? '' : 'es'})` + (heldoutCount > 0 ? `, held-out ${heldoutCount} (excluded)` : ''));
}
