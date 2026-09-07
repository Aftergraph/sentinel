#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { review, resolveFinding } from '../lib/review.js';
import { readFileSync } from 'node:fs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    pr: { type: 'string' },
    repo: { type: 'string' },
    format: { type: 'string', default: 'human' },
    'rule-id': { type: 'string' },
    file: { type: 'string' },
    evidence: { type: 'string' },
    'head-sha': { type: 'string' },
    reason: { type: 'string', default: 'manual' },
    'memory-path': { type: 'string' }
  }
});

const cmd = positionals[0];

try {
  if (cmd === 'review') {
    if (!values.pr) {
      console.error('Error: --pr is required');
      process.exit(1);
    }
    await review({
      pr: parseInt(values.pr, 10),
      repo: values.repo,
      format: values.format,
      memoryPath: values['memory-path']
    });
  } else if (cmd === 'resolve') {
    if (!values['rule-id'] || !values.file) {
      console.error('Usage: sentinel resolve --rule-id <id> --file <path> [--evidence <text>] [--head-sha <sha>] [--reason <text>]');
      process.exit(1);
    }
    const rec = resolveFinding({
      ruleId: values['rule-id'],
      file: values.file,
      evidence: values.evidence || '',
      headSha: values['head-sha'] || null,
      reason: values.reason || 'manual',
      memoryPath: values['memory-path']
    });
    console.log(`Resolved: ${rec.ruleId} in ${rec.file} (fingerprint=${rec.fingerprint})`);
    process.exit(0);
  } else {
    console.error('Usage: sentinel <review|resolve> [options]');
    process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
