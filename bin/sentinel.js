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
import { execSync, execFileSync } from 'node:child_process';
// Additive imports for the policy-gated review and verify-run surface.
// Existing import lines above are untouched.
import {
  loadConfig as loadReviewConfig, environmentInfo as reviewEnvironmentInfo,
  summarizeDiff as reviewSummarizeDiff, loadRules as loadReviewRules,
  filterExcluded as reviewFilterExcluded, computeVerdict as reviewComputeVerdict,
  computeDelta as reviewComputeDelta, formatHuman as reviewFormatHuman,
  toJson as reviewToJson, toSarif as reviewToSarif, toGov as reviewToGov,
  readDiffInput as reviewReadDiffInput, localHeadSha as reviewLocalHeadSha,
} from '../lib/review.js';
import {
  defaultLedgerPath as receiptDefaultLedgerPath, loadLedger as receiptLoadLedger,
  latestForRepoPr as receiptLatestForRepoPr, makeReceipt as receiptMakeReceipt,
  appendLedger as receiptAppendLedger, detectSource as receiptDetectSource,
} from '../lib/receipt.js';
import { load as loadMemory } from '../lib/memory.js';
import { ruleIdsForPack as cliRuleIdsForPack } from '../lib/rulepack.js';
import { parsePolicy as parseCliPolicy } from '../lib/policy.js';
import { createFinding as cliCreateFinding } from '../lib/finding.js';
import { executePipeline as cliExecutePipeline } from '../lib/pipeline.js';

// --- Additive helpers: policy-gated review + verify run (new flags only) ---

const CLI_ANSI = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m' };

// Same TTY-only convention as lib/review.js: color only on a live terminal,
// never in pipes, so piped output stays byte-clean.
function cliPaint(text, code, on) {
  return on ? `${code}${text}${CLI_ANSI.reset}` : text;
}

function cliGhApi(endpoint, repo) {
  const out = execSync(`gh api repos/${repo}/${endpoint}`, { encoding: 'utf8' });
  return JSON.parse(out);
}

function cliResolveRepo(explicit) {
  if (explicit) return explicit;
  const remote = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
  const m = remote.match(/github\.com[:\/]([^\/]+\/[^\/]+?)(?:\.git)?$/);
  if (!m) throw new Error('Cannot resolve repo from origin remote');
  return m[1];
}

// review --policy <file>: same pipeline as review(), except the verdict is
// gated by the versioned policy file scoped to the reviewed repo
// (meta.policy = { policies, repo, checks: {} }). A missing/unparseable
// policy file fails closed with exit 2 and no verdict. Human output gains a
// `policy: <name>@<hash8> <verdict>` line; --format json gains a top-level
// policyEvaluation object; gov/sarif shapes are unchanged.
async function reviewWithPolicy({
  pr, repo: explicitRepo, format = 'human', memoryPath,
  rulePackVersion, source, ledgerPath, noLedger = false, configPath,
  diffInput, headSha: explicitHeadSha, baseSha: explicitBaseSha, policyPath,
}) {
  const localMode = diffInput != null && diffInput !== '';
  if (!pr && !localMode) {
    console.error('Error: --pr is required (or use --diff <file|-> for local mode)\nUsage: sentinel review --pr <n> [--repo owner/name] [--format human|json|sarif|gov]');
    process.exit(1);
  }
  if (!VALID_FORMATS.includes(format)) {
    console.error(`Error: --format must be one of ${VALID_FORMATS.join(', ')} (got "${format}")`);
    process.exit(1);
  }
  if (rulePackVersion != null && !SUPPORTED_PACKS.includes(rulePackVersion)) {
    console.error(`Error: --rule-pack must be one of ${SUPPORTED_PACKS.join(', ')} (got "${rulePackVersion}")`);
    process.exit(1);
  }
  if (source != null && !SOURCE_ENUM.includes(source)) {
    console.error(`Error: --source must be one of ${SOURCE_ENUM.join(', ')} (got "${source}")`);
    process.exit(1);
  }
  // Fail closed before any verdict work: exit 2, nothing on stdout.
  let policyText;
  try {
    policyText = readFileSync(policyPath, 'utf8');
  } catch {
    console.error(`Error: cannot read policy file: ${policyPath}`);
    process.exit(2);
  }
  let policy;
  try {
    policy = parseCliPolicy(policyText);
  } catch (err) {
    console.error(`Error: invalid policy file ${policyPath}: ${err.message}`);
    process.exit(2);
  }

  const resolvedSource = source || receiptDetectSource();
  if (!SOURCE_ENUM.includes(resolvedSource)) {
    throw new Error(`Unsupported source: ${resolvedSource} (expected one of ${SOURCE_ENUM.join(', ')})`);
  }
  const { config, configHash } = loadReviewConfig(configPath);
  const pack = rulePackVersion || config.rulePack || RULE_PACK_VERSION;
  const useColor = format === 'human' && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

  let repo;
  let headSha;
  let baseShaStart;
  let diffText;
  if (localMode) {
    diffText = reviewReadDiffInput(diffInput);
    repo = explicitRepo || `local/${process.cwd().split(/[\\/]/).pop()}`;
    headSha = reviewLocalHeadSha(diffText, explicitHeadSha);
    baseShaStart = explicitBaseSha || 'local-base';
  } else {
    repo = cliResolveRepo(explicitRepo);
    const prData = cliGhApi(`pulls/${pr}`, repo);
    headSha = prData.head.sha;
    baseShaStart = prData.base.sha;
    diffText = execSync(
      `gh api repos/${repo}/pulls/${pr} -H "Accept: application/vnd.github.v3.diff"`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
    );
  }

  const ledgerFile = ledgerPath || receiptDefaultLedgerPath();
  const chain = noLedger ? [] : receiptLoadLedger(ledgerFile);
  const prev = noLedger ? null : receiptLatestForRepoPr(chain, repo, pr);
  const prevHeadSha = prev && prev.headSha !== headSha ? prev.headSha : null;

  const environment = reviewEnvironmentInfo();
  const buildReceipt = (verdict, snap) => receiptMakeReceipt({
    repo,
    prNumber: pr,
    headSha,
    baseSha: baseShaStart,
    rulePackVersion: pack,
    verdict,
    findings: snap,
    counts: {
      blocking: snap.blocking.length,
      silenced: snap.silenced.length,
      nonBlocking: snap.nonBlocking.length,
      excluded: snap.excluded.length,
    },
    configHash,
    source: resolvedSource,
    environment,
    prevReceiptId: prev ? prev.receipt_id : null,
  });

  let fresh = { fresh: true };
  if (!localMode) {
    const prDataCheck = cliGhApi(`pulls/${pr}`, repo);
    const moved = [];
    if (headSha !== prDataCheck.head.sha) moved.push(`head moved from ${headSha} to ${prDataCheck.head.sha}`);
    if (baseShaStart !== prDataCheck.base.sha) moved.push(`base moved from ${baseShaStart} to ${prDataCheck.base.sha}`);
    fresh = moved.length === 0 ? { fresh: true } : { fresh: false, reason: moved.join('; ') };
  }
  if (!fresh.fresh) {
    const staleResult = {
      verdict: 'STALE', headSha, baseSha: baseShaStart, rulePackVersion: pack,
      blocking: [], silenced: [], nonBlocking: [], excluded: [],
      checksPassed: cliRuleIdsForPack(pack).length,
    };
    const summary = reviewSummarizeDiff(diffText);
    const receipt = buildReceipt('STALE', { blocking: [], silenced: [], nonBlocking: [], excluded: [] });
    if (!noLedger) receiptAppendLedger(receipt, ledgerFile);
    emitPolicy(staleResult, { summary, delta: null, receipt, staleReason: fresh.reason });
    process.exit(2);
  }

  const resolutions = loadMemory(memoryPath);
  // analyzeDiff body with meta.policy threaded through computeVerdict
  // (analyzeDiff itself has no policy slot and lib/ is frozen).
  const summary = reviewSummarizeDiff(diffText);
  const rules = await loadReviewRules(pack);
  const rawFindings = [];
  for (const { check } of rules) rawFindings.push(...check(diffText));
  rawFindings.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 :
    a.line - b.line || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)
  );
  const { included, excluded } = reviewFilterExcluded(rawFindings, config.exclude);
  let result;
  try {
    result = reviewComputeVerdict(included, resolutions, {
      headSha,
      baseSha: baseShaStart,
      rulePackVersion: pack,
      policy: { policies: [policy], repo, checks: {} },
    }, excluded);
  } catch (err) {
    console.error(`Error: policy evaluation failed: ${err.message}`);
    process.exit(2);
  }

  const delta = prevHeadSha
    ? { prevHeadSha, ...reviewComputeDelta((prev.findings || {}).blocking, result.blocking) }
    : null;
  const snapshot = {
    blocking: result.blocking,
    silenced: result.silenced,
    nonBlocking: result.nonBlocking,
    excluded: result.excluded,
  };
  const receipt = buildReceipt(result.verdict, snapshot);
  if (!noLedger) receiptAppendLedger(receipt, ledgerFile);

  emitPolicy(result, { summary, delta, receipt });

  function emitPolicy(res, extra) {
    const pv = res.policyEvaluation;
    const hash8 = String((pv?.policyVersion || '').split('@')[1] || '').slice(0, 8);
    const policyLine = `policy: ${policy.metadata.name}@${hash8} ${pv?.verdict ?? 'UNKNOWN'}`;
    if (format === 'sarif') {
      console.log(JSON.stringify(reviewToSarif(res), null, 2));
    } else if (format === 'json') {
      const out = reviewToJson(res, { repo, prNumber: pr, ...extra });
      out.policyEvaluation = res.policyEvaluation;
      console.log(JSON.stringify(out, null, 2));
    } else if (format === 'gov') {
      console.log(JSON.stringify(reviewToGov(res, {
        repo, prNumber: pr, source: resolvedSource, environment, runId: extra.receipt.run_id,
      }), null, 2));
    } else {
      console.log(reviewFormatHuman(res, {
        summary: extra.summary, delta: extra.delta, receipt: extra.receipt,
        staleReason: extra.staleReason, color: useColor,
      }) + `\n${policyLine}`);
    }
  }

  process.exit(result.verdict === 'SHIP' ? 0 : 1);
}

// verify run --finding <ruleId:file:line> --repo-dir <dir> --commands <jsonfile>:
// execute the verify pipeline with a caller-supplied command table.
// Unknown/misconfigured check types fail closed (exit 2) pre-exec — the
// pipeline itself guarantees nothing executes. Human output prints the run
// id, per-check PASS/FAIL/TIMEOUT, the finding transition, and sealed
// evidence ids; --format json emits the same machine-readably.
async function verifyRunCommand({ finding: findingSpec, repoDir, commands: commandsPath, format = 'human' }) {
  if (format !== 'human' && format !== 'json') {
    console.error(`Error: verify run --format must be human or json (got "${format}")`);
    process.exit(1);
  }
  if (!findingSpec || !repoDir || !commandsPath) {
    console.error('Usage: sentinel verify run --finding <ruleId:file:line> --repo-dir <dir> --commands <jsonfile> [--format human|json]');
    process.exit(1);
  }
  const spec = String(findingSpec);
  const first = spec.indexOf(':');
  const last = spec.lastIndexOf(':');
  const ruleId = first > 0 ? spec.slice(0, first) : '';
  const file = first >= 0 && last > first ? spec.slice(first + 1, last) : '';
  const line = Number.parseInt(spec.slice(last + 1), 10);
  if (first < 0 || last <= first || !ruleId || !file || !Number.isInteger(line)) {
    console.error('Usage: sentinel verify run --finding <ruleId:file:line> --repo-dir <dir> --commands <jsonfile> [--format human|json]');
    process.exit(1);
  }
  let commands;
  try {
    commands = JSON.parse(readFileSync(commandsPath, 'utf8'));
  } catch (err) {
    console.error(`Error: cannot load commands file ${commandsPath}: ${err.message}`);
    process.exit(2);
  }
  let targetSha;
  try {
    targetSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    console.error(`Error: cannot resolve HEAD in --repo-dir: ${repoDir}`);
    process.exit(2);
  }
  if (!targetSha) {
    console.error(`Error: cannot resolve HEAD in --repo-dir: ${repoDir}`);
    process.exit(2);
  }
  const finding = cliCreateFinding({ ruleId, file, line, evidence: '', targetSha });
  const fromState = finding.verification_state;
  let out;
  try {
    out = await cliExecutePipeline({
      finding,
      repoDir,
      targetSha,
      commands,
      env: { PATH: process.env.PATH || '' },
    });
  } catch (err) {
    console.error(`Error: verify run failed: ${err.message}`);
    process.exit(2);
  }
  const toState = finding.verification_state;
  const checks = out.evidence.map((ev) => ({
    type: ev.type,
    status: String(ev.result).toUpperCase(),
    exitCode: ev.exitCode,
    evidenceId: ev.id,
  }));
  const useColor = format === 'human' && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  if (format === 'json') {
    console.log(JSON.stringify({
      run: { id: out.run.id, status: out.run.status, checks },
      finding: { id: finding.id, ruleId, file, line, from: fromState, to: toState, verification_state: toState },
      evidence: out.evidence.map((ev) => ev.id),
    }, null, 2));
  } else {
    const paintStatus = (s) => s === 'PASS' ? cliPaint(s, CLI_ANSI.green, useColor)
      : s === 'FAIL' ? cliPaint(s, CLI_ANSI.red, useColor)
      : cliPaint(s, CLI_ANSI.yellow, useColor);
    const lines = [`run: ${out.run.id}`];
    for (const c of checks) lines.push(`check ${c.type}: ${paintStatus(c.status)} (exit ${c.exitCode ?? 'n/a'})`);
    lines.push(`finding: ${finding.id} ${fromState} -> ${toState}`);
    for (const ev of out.evidence) lines.push(`evidence: ${ev.id}`);
    console.log(lines.join('\n'));
  }
  process.exit(0);
}

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
  sentinel review --diff <file|-> --repo a/b --policy <path> [--format human|json|sarif|gov]
  sentinel verify run --finding <ruleId:file:line> --repo-dir <dir> --commands <jsonfile> [--format human|json]
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
    policy: { type: 'string' },
    finding: { type: 'string' },
    'repo-dir': { type: 'string' },
    commands: { type: 'string' },
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
  if (cmd === 'review' && values.policy != null && values.policy !== '') {
    await reviewWithPolicy({
      pr: values.pr != null ? parseInt(values.pr, 10) : 0,
      repo: values.repo,
      format: values.format,
      memoryPath: values['memory-path'],
      rulePackVersion: values['rule-pack'] || undefined,
      source: values.source || undefined,
      ledgerPath: values['ledger-path'] || undefined,
      noLedger: values['no-ledger'] || false,
      configPath: values.config || undefined,
      diffInput: values.diff != null && values.diff !== '' ? values.diff : undefined,
      headSha: values['head-sha'] || undefined,
      baseSha: values['base-sha'] || undefined,
      policyPath: values.policy,
    });
  } else if (cmd === 'review') {
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
  } else if (cmd === 'verify' && positionals[1] === 'run') {
    await verifyRunCommand({
      finding: values.finding,
      repoDir: values['repo-dir'],
      commands: values.commands,
      format: values.format,
    });
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
