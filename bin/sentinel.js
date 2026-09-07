#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { review } from '../lib/review.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    pr: { type: 'string' },
    repo: { type: 'string' },
    format: { type: 'string', default: 'human' }
  }
});

if (positionals[0] !== 'review') {
  console.error('Usage: sentinel review --pr <n> [--repo <owner/name>] [--format human]');
  process.exit(1);
}

if (!values.pr) {
  console.error('Error: --pr is required');
  process.exit(1);
}

try {
  await review({
    pr: parseInt(values.pr, 10),
    repo: values.repo,
    format: values.format
  });
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
