#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { review, resolveFinding, VALID_FORMATS } from '../lib/review.js';
import { RULE_PACK_VERSION, SUPPORTED_PACKS } from '../lib/rulepack.js';
import { SOURCE_ENUM, verifyReceipt } from '../lib/receipt.js';
import { createConsoleServer, listen as listenConsole } from '../console/server.js';
import { createPlatform } from '../apps/github/platform.js';
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
  sentinel review --pr <n> [--repo owner/name] [--format human|json|sarif|gov] [--rule-pack ${SUPPORTED_PACKS.join('|')}] [--source ${SOURCE_ENUM.join('|')}] [--ledger-path <path>] [--no-ledger] [--config <path>] [--memory-path <path>]
  sentinel review --diff <file|-> [--repo owner/name] [--pr <n>] [--head-sha <sha>] [--base-sha <sha>] [same flags as above]
  sentinel serve [--port 8787] [--host 127.0.0.1] [--repo a/b,c/d] [--token <bearer>] [--ledger-path <p>] [--memory-path <p>] [--config <p>] [--topology <p>] [--org-state <p>]
  sentinel resolve --rule-id <id> --file <path> [--evidence <text>] [--head-sha <sha>] [--reason <text>] [--memory-path <path>]
  sentinel verify --receipt <path>
  sentinel --help

Exit codes (contract, never silently changed):
  0  SHIP — verified HEAD, no blocking findings (verify: receipt VALID)
  1  DO NOT SHIP — verified HEAD, >=1 blocking finding (or usage error; verify: INVALID)
  2  STALE — HEAD or base moved mid-review; no verdict issued (a STALE receipt is still recorded)

Formats:
  human  Verdict first with cited file:line evidence (default)
  json   Review + Verdict + Findings + summary + delta + receipt
  sarif  SARIF 2.1.0 run wrapped in a { verdict, sarif } envelope
  gov    ci-result-shaped verdict for Aftergraph governance consumers (see docs/receipts-v0.1.md)

Receipts:
  Every review appends a content-addressed receipt (sha256 over the verdict
  body) to ~/.sentinel/ledger.jsonl, hash-chained per repo+PR. Re-running
  the same HEAD+pack yields the same receipt_id. This ledger is a LOCAL
  claim log — not platform L1/L2 evidence. 'verify' recomputes the hash
  offline: no network, no trust required.

Config (sentinel.config.json in cwd, or --config):
  { "rulePack": "1.2.0", "exclude": ["docs/**", "*.md"] }
  Excluded findings are reported, never block. Malformed config fails closed.

Console v1b (org-wide, display-only — see docs/console-v1b.md):
  --topology <path>   Aftergraph platform-topology/1.0.json (repo list)
  --org-state <path>  generated latest-org-state.json (exact HEAD per repo)

Local mode (no GitHub, no auth — pre-commit hooks, piped diffs):
  git diff | sentinel review --diff - --repo myorg/myrepo
  sentinel review --diff /tmp/change.diff --head-sha $(git rev-parse HEAD)
  # verdict binds to --head-sha, else to a content hash (local:<sha12>);
  # freshness has no remote to check, so STALE cannot occur locally.

Examples:
  sentinel review --pr 42
  sentinel review --pr 42 --format sarif > results.sarif
  sentinel review --pr 42 --format gov | jq .results
  sentinel review --pr 42 --rule-pack 1.0.0
  sentinel verify --receipt ./receipt-abc123.json

CI gate (GitHub Actions):
  - run: sentinel review --pr \${{ github.event.pull_request.number }} --format json
  # gate on exit code: 0 pass, 1 fail, 2 re-run (never treat 2 as failure)

Read-only by construction: review performs zero writes to the repo, PR, or
checks (ledger + stdout are local). Verdicts go to stdout only.`);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    pr: { type: 'string' },
    repo: { type: 'string' },
    diff: { type: 'string' },
    'base-sha': { type: 'string' },
    format: { type: 'string', default: 'human' },
    'rule-pack': { type: 'string' },
    source: { type: 'string' },
    'ledger-path': { type: 'string' },
    'no-ledger': { type: 'boolean', default: false },
    config: { type: 'string' },
    receipt: { type: 'string' },
    port: { type: 'string', default: '8787' },
    host: { type: 'string', default: '127.0.0.1' },
    token: { type: 'string' },
    topology: { type: 'string' },
    'org-state': { type: 'string' },
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
    const localMode = values.diff != null && values.diff !== '';
    if (!values.pr && !localMode) {
      console.error('Error: --pr is required (or use --diff <file|-> for local mode)\nUsage: sentinel review --pr <n> [--repo owner/name] [--format human|json|sarif|gov]');
      process.exit(1);
    }
    if (!VALID_FORMATS.includes(values.format)) {
      console.error(`Error: --format must be one of ${VALID_FORMATS.join(', ')} (got "${values.format}")`);
      process.exit(1);
    }
    if (values['rule-pack'] != null && !SUPPORTED_PACKS.includes(values['rule-pack'])) {
      console.error(`Error: --rule-pack must be one of ${SUPPORTED_PACKS.join(', ')} (got "${values['rule-pack']}")`);
      process.exit(1);
    }
    if (values.source != null && !SOURCE_ENUM.includes(values.source)) {
      console.error(`Error: --source must be one of ${SOURCE_ENUM.join(', ')} (got "${values.source}")`);
      process.exit(1);
    }
    await review({
      pr: values.pr != null ? parseInt(values.pr, 10) : 0,
      repo: values.repo,
      format: values.format,
      memoryPath: values['memory-path'],
      rulePackVersion: values['rule-pack'] || undefined,
      source: values.source || undefined,
      ledgerPath: values['ledger-path'] || undefined,
      noLedger: values['no-ledger'] || false,
      configPath: values.config || undefined,
      diffInput: localMode ? values.diff : undefined,
      headSha: values['head-sha'] || undefined,
      baseSha: values['base-sha'] || undefined,
    });
  } else if (cmd === 'serve') {
    const host = values.host || '127.0.0.1';
    const token = values.token || process.env.SENTINEL_CONSOLE_TOKEN || undefined;
    if (host !== '127.0.0.1' && host !== 'localhost' && !token) {
      console.error('Refusing remote bind without a token: pass --token or set SENTINEL_CONSOLE_TOKEN');
      process.exit(1);
    }
    const ghToken = process.env.GITHUB_TOKEN || undefined;
    const handler = createConsoleServer({
      ledgerPath: values['ledger-path'] || undefined,
      memoryPath: values['memory-path'] || undefined,
      configPath: values.config || undefined,
      token,
      repos: values.repo ? String(values.repo).split(',').map((s) => s.trim()).filter(Boolean) : [],
      platform: ghToken ? createPlatform({ token: ghToken }) : undefined,
      topologyPath: values.topology || undefined,
      orgStatePath: values['org-state'] || undefined,
    });
    const port = parseInt(values.port || '8787', 10);
    listenConsole(handler, { port, host });
    console.error(`sentinel console on http://${host}:${port} (open in a browser)`);
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
  } else if (cmd === 'verify') {
    if (!values.receipt) {
      console.error('Usage: sentinel verify --receipt <path>');
      process.exit(1);
    }
    let rec;
    try {
      rec = JSON.parse(readFileSync(values.receipt, 'utf8'));
    } catch {
      console.error(`INVALID — cannot read receipt: ${values.receipt}`);
      process.exit(1);
    }
    const v = verifyReceipt(rec);
    if (v.valid) {
      console.log(`VALID — ${rec.receipt_id} (${rec.verdict} @ ${String(rec.headSha).slice(0, 7)}, pack ${rec.rulePackVersion})`);
      process.exit(0);
    } else {
      console.error(`INVALID — ${v.reason}`);
      process.exit(1);
    }
  } else {
    console.error(`Unknown command: ${cmd}`);
    printHelp();
    process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
