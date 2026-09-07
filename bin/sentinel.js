#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { review, resolveFinding, VALID_FORMATS } from '../lib/review.js';
import { RULE_PACK_VERSION, SUPPORTED_PACKS } from '../lib/rulepack.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function pkgVersion() {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(dir, '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printHelp() {
  console.log(`sentinel v${pkgVersion()} — verified code review on exact HEAD

Usage:
  sentinel review --pr <n> [--repo owner/name] [--format human|json|sarif] [--rule-pack ${SUPPORTED_PACKS.join('|')}] [--memory-path <path>]
  sentinel resolve --rule-id <id> --file <path> [--evidence <text>] [--head-sha <sha>] [--reason <text>] [--memory-path <path>]
  sentinel --help

Exit codes (contract, never silently changed):
  0  SHIP — verified HEAD, no blocking findings
  1  DO NOT SHIP — verified HEAD, >=1 blocking finding (or usage error)
  2  STALE — HEAD or base moved mid-review; no verdict issued

Formats:
  human  Verdict first with cited file:line evidence (default)
  json   Review + Verdict + Findings records per docs/data-model-v0.md
  sarif  SARIF 2.1.0 run wrapped in a { verdict, sarif } envelope

Rule packs:
  1.0.0  Original 6-rule precision-audited pack
  1.1.0  20-rule pack: v1.0.0 + 14 deterministic additions (default: ${RULE_PACK_VERSION})

Examples:
  sentinel review --pr 42
  sentinel review --pr 42 --format sarif > results.sarif
  sentinel review --pr 42 --format json | jq .verdict.decision
  sentinel review --pr 42 --rule-pack 1.0.0

CI gate (GitHub Actions):
  - run: sentinel review --pr \${{ github.event.pull_request.number }} --format json
  # gate on exit code: 0 pass, 1 fail, 2 re-run (never treat 2 as failure)

Read-only by construction: review performs zero writes (no comments,
no checks, no commits). Verdicts go to stdout only.`);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    pr: { type: 'string' },
    repo: { type: 'string' },
    format: { type: 'string', default: 'human' },
    'rule-pack': { type: 'string', default: RULE_PACK_VERSION },
    'rule-id': { type: 'string' },
    file: { type: 'string' },
    evidence: { type: 'string' },
    'head-sha': { type: 'string' },
    reason: { type: 'string', default: 'manual' },
    'memory-path': { type: 'string' },
    help: { type: 'boolean', default: false },
    version: { type: 'boolean', default: false },
  }
});

const cmd = positionals[0];

try {
  if (values.version) {
    console.log(pkgVersion());
    process.exit(0);
  }
  if (values.help || cmd === 'help' || !cmd) {
    printHelp();
    process.exit(cmd && cmd !== 'help' ? 1 : 0);
  }
  if (cmd === 'review') {
    if (!values.pr) {
      console.error('Error: --pr is required\nUsage: sentinel review --pr <n> [--repo owner/name] [--format human|json|sarif]');
      process.exit(1);
    }
    if (!VALID_FORMATS.includes(values.format)) {
      console.error(`Error: --format must be one of ${VALID_FORMATS.join(', ')} (got "${values.format}")`);
      process.exit(1);
    }
    if (!SUPPORTED_PACKS.includes(values['rule-pack'])) {
      console.error(`Error: --rule-pack must be one of ${SUPPORTED_PACKS.join(', ')} (got "${values['rule-pack']}")`);
      process.exit(1);
    }
    await review({
      pr: parseInt(values.pr, 10),
      repo: values.repo,
      format: values.format,
      memoryPath: values['memory-path'],
      rulePackVersion: values['rule-pack'],
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
    console.error(`Unknown command: ${cmd}`);
    printHelp();
    process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
