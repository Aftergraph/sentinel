import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { platform, arch } from 'node:os';
import { createHash } from 'node:crypto';
import { load, partition, append as memAppend, keyOf } from './memory.js';
import { RULE_PACK_VERSION, SUPPORTED_PACKS, SEVERITY_MAP, BLOCKING_SEVERITIES, ruleIdsForPack } from './rulepack.js';
import { resolvePolicy, evaluatePolicy } from './policy.js';
import {
  SOURCE_ENUM, defaultLedgerPath, detectSource,
  makeReceipt, appendLedger, loadLedger, latestForRepoPr,
} from './receipt.js';
import { parseDiff } from './rules/_diff-parse.js';
// Additive: verdict-override audit trail (append-only, no other coupling).
import { append as appendAuditEvent } from './audit.js';

function ghApi(endpoint, repo) {
  const out = execSync(`gh api repos/${repo}/${endpoint}`, { encoding: 'utf8' });
  return JSON.parse(out);
}

function resolveRepo(explicit) {
  if (explicit) return explicit;
  const remote = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
  const m = remote.match(/github\.com[:\/]([^\/]+\/[^\/]+?)(?:\.git)?$/);
  if (!m) throw new Error('Cannot resolve repo from origin remote');
  return m[1];
}

export const VALID_FORMATS = ['human', 'json', 'sarif', 'gov'];

export async function loadRules(packVersion = RULE_PACK_VERSION) {
  const ids = ruleIdsForPack(packVersion);
  const rules = [];
  for (const id of ids) {
    const mod = await import(`./rules/${id}.js`);
    rules.push({ ruleId: id, check: mod.check });
  }
  return rules;
}

// Pure: exact-head freshness gate. A verdict is only valid for the HEAD
// it reviewed — if either end moved mid-review the evidence is stale.
// ponytail: string compare is the whole check; SHA equality needs no hashing.
export function checkFreshness(start, end) {
  const moved = [];
  if (start.headSha !== end.headSha) moved.push(`head moved from ${start.headSha} to ${end.headSha}`);
  if (start.baseSha !== end.baseSha) moved.push(`base moved from ${start.baseSha} to ${end.baseSha}`);
  return moved.length === 0 ? { fresh: true } : { fresh: false, reason: moved.join('; ') };
}

// Verdict strictness ladder for policy enforcement: a policy verdict can
// only ESCALATE, never de-escalate — the final verdict is the strictest of
// (rule verdict, policy verdict). STALE is issued by the exact-head
// freshness gate in review(), which bypasses computeVerdict and policy
// entirely, so a STALE verdict always stands outright (it outranks BLOCKED
// and SHIP, and only DO_NOT_SHIP outranks it).
export const VERDICT_STRICTNESS = Object.freeze({
  SHIP: 0,
  BLOCKED: 1,
  STALE: 2,
  DO_NOT_SHIP: 3,
});

// Pure: compute verdict + structured output from findings + resolutions.
// Style-severity findings are reported in nonBlocking and never flip the
// verdict (cli-v0-design §6). Silenced (resolved) findings never block.
//
// Optional policy gate (additive): meta.policy = { policies, repo, path,
// checks } resolves the matching policy, evaluates it over the still-open
// findings, and attaches the evaluation as result.policyEvaluation
// { policyVersion, verdict, reasons }. Fail closed: malformed policy input
// throws and no verdict is returned. Without meta.policy the result keeps
// every pre-existing field byte-identical, plus policyEvaluation: null.
export function computeVerdict(findings, resolutions, meta, excluded = []) {
  const { blocking: unresolved, silenced } = partition(findings, resolutions);
  const blocking = unresolved.filter((f) => BLOCKING_SEVERITIES.has(SEVERITY_MAP[f.ruleId] || 'security'));
  const nonBlocking = unresolved.filter((f) => !BLOCKING_SEVERITIES.has(SEVERITY_MAP[f.ruleId] || 'security'));
  let verdict = blocking.length === 0 ? 'SHIP' : 'DO_NOT_SHIP';
  let policyEvaluation = null;
  if (meta.policy != null) {
    const { policies, repo, path, checks } = meta.policy;
    const policy = resolvePolicy(policies, { repo, path });
    const evaluated = evaluatePolicy(policy, { findings: unresolved, checks, headSha: meta.headSha });
    policyEvaluation = {
      policyVersion: evaluated.policyVersion,
      verdict: evaluated.verdict,
      reasons: evaluated.reasons,
    };
    if (VERDICT_STRICTNESS[evaluated.verdict] > VERDICT_STRICTNESS[verdict]) {
      verdict = evaluated.verdict;
    }
  }
  const rulePackVersion = meta.rulePackVersion || RULE_PACK_VERSION;
  const result = {
    verdict,
    headSha: meta.headSha,
    baseSha: meta.baseSha,
    rulePackVersion,
    blocking,
    silenced,
    nonBlocking,
    excluded,
    checksPassed: meta.checksPassed ?? ruleIdsForPack(rulePackVersion).length,
    policyEvaluation,
  };
  // Additive verdict-override path: meta.override = { verdict, actor, reason }.
  // Without meta.override the result above is returned untouched (no new
  // keys, no behavior change). With it, the computed verdict is preserved in
  // result.overriddenFrom, the verdict is replaced, and one append-only audit
  // event (verdict.overridden) records the change. Fail closed: malformed
  // overrides throw and no overridden verdict is returned.
  if (meta.override == null) return result;
  const { verdict: toVerdict, actor, reason } = meta.override;
  if (toVerdict !== 'SHIP' && toVerdict !== 'DO_NOT_SHIP') {
    throw new Error(`Invalid override verdict (must be SHIP or DO_NOT_SHIP): ${String(toVerdict)}`);
  }
  if (typeof actor !== 'string' || actor.trim() === '' || typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('Invalid override (verdict, actor, and reason are all required and non-empty)');
  }
  // The exact-head freshness gate bypasses computeVerdict/policy entirely, so
  // a STALE verdict always stands outright and can never be overridden here.
  if (verdict === 'STALE') {
    throw new Error('override never applies to STALE (freshness gate wins)');
  }
  if (toVerdict === verdict) {
    throw new Error('override must change the verdict');
  }
  const event = appendAuditEvent('verdict.overridden', { actor, reason, from: verdict, to: toVerdict });
  event.headSha = meta.headSha;
  return {
    ...result,
    verdict: toVerdict,
    overriddenFrom: verdict,
    overridden: { actor, reason, from: verdict, to: toVerdict },
  };
}

// Deterministic PR summary from the unified diff (CodeRabbit-style header,
// computed — no LLM). Counts added lines and removed lines per file.
export function summarizeDiff(diffText) {
  const files = parseDiff(diffText || '');
  let added = 0;
  let removed = 0;
  const top = [];
  for (const f of files) {
    added += f.addedLines.length;
    removed += f.removedCount || 0;
    top.push({ path: f.path, added: f.addedLines.length, removed: f.removedCount || 0 });
  }
  top.sort((a, b) => (b.added + b.removed) - (a.added + a.removed));
  return { files: files.length, added, removed, top: top.slice(0, 3) };
}

// Verdict delta across HEADs: new = blocking now, absent before; fixed =
// blocking before, absent now; carried = blocking in both. Pure.
export function computeDelta(prevBlocking, currBlocking) {
  const prev = new Map((prevBlocking || []).map((f) => [keyOf(f), f]));
  const curr = new Map((currBlocking || []).map((f) => [keyOf(f), f]));
  const added = [];
  const fixed = [];
  for (const [k, f] of curr) if (!prev.has(k)) added.push(f);
  for (const [k, f] of prev) if (!curr.has(k)) fixed.push(f);
  return { new: added, fixed, carried: curr.size - added.length };
}

// Minimal glob support for config excludes: ** spans directories,
// * spans within a segment, ? is one non-separator char.
export function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/, '\\$&');
    }
  }
  return new RegExp(out + '$');
}

export function filterExcluded(findings, patterns) {
  if (!patterns || patterns.length === 0) return { included: findings, excluded: [] };
  const res = patterns.map(globToRegExp);
  const included = [];
  const excluded = [];
  for (const f of findings) {
    if (res.some((re) => re.test(f.file))) excluded.push(f);
    else included.push(f);
  }
  return { included, excluded };
}

const CONFIG_KEYS = ['rulePack', 'exclude'];

// sentinel.config.json in cwd (or explicit path): {rulePack?, exclude[]?}.
// Fails closed on malformed JSON, unknown keys, or bad shapes —
// a config that silently weakens a verdict would break the product contract.
export function loadConfig(explicitPath) {
  const path = explicitPath || 'sentinel.config.json';
  if (!existsSync(path)) return { config: { rulePack: null, exclude: [] }, configHash: null, path: null };
  const raw = readFileSync(path, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid sentinel config (not JSON): ${path}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid sentinel config (must be an object): ${path}`);
  }
  for (const k of Object.keys(parsed)) {
    if (!CONFIG_KEYS.includes(k)) throw new Error(`Invalid sentinel config (unknown key "${k}"): ${path}`);
  }
  if (parsed.rulePack != null && !SUPPORTED_PACKS.includes(parsed.rulePack)) {
    throw new Error(`Invalid sentinel config (rulePack must be one of ${SUPPORTED_PACKS.join(', ')}): ${path}`);
  }
  if (parsed.exclude != null && (!Array.isArray(parsed.exclude) || parsed.exclude.some((p) => typeof p !== 'string'))) {
    throw new Error(`Invalid sentinel config (exclude must be an array of strings): ${path}`);
  }
  return {
    config: { rulePack: parsed.rulePack || null, exclude: parsed.exclude || [] },
    configHash: createHash('sha256').update(raw).digest('hex').slice(0, 16),
    path,
  };
}

export function environmentInfo() {
  let sentinel = '0.0.0';
  try {
    const url = new URL('../package.json', import.meta.url);
    sentinel = JSON.parse(readFileSync(url, 'utf8')).version || sentinel;
  } catch { /* keep default */ }
  return {
    runner: `${platform()}-${arch()}`,
    versions: { node: process.version, sentinel, rulepack: RULE_PACK_VERSION },
  };
}

// SARIF 2.1.0 envelope with verdict wrapper.
export function toSarif(result) {
  const sarifResults = [];
  const nonBlocking = result.nonBlocking || [];
  const excluded = result.excluded || [];
  for (const f of [...result.blocking, ...result.silenced, ...nonBlocking, ...excluded]) {
    const sev = SEVERITY_MAP[f.ruleId];
    const level = sev === 'security' ? 'error'
      : sev === 'reliability' ? 'error'
      : sev === 'correctness' ? 'error'
      : sev === 'style' ? 'note'
      : 'warning';
    sarifResults.push({
      ruleId: f.ruleId,
      level,
      message: { text: f.evidence },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: f.file },
          region: { startLine: f.line }
        }
      }],
      properties: {
        status: result.silenced.includes(f) ? 'silenced'
          : (result.excluded || []).includes(f) ? 'excluded'
          : 'open'
      }
    });
  }
  return {
    verdict: {
      verdict: result.verdict,
      headSha: result.headSha,
      baseSha: result.baseSha,
      rulePackVersion: result.rulePackVersion,
    },
    sarif: {
      $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
      version: '2.1.0',
      runs: [{
        tool: {
          driver: {
            name: 'sentinel',
            version: result.rulePackVersion,
            rules: ruleIdsForPack(result.rulePackVersion).map(id => ({ id, shortDescription: { text: id } }))
          }
        },
        results: sarifResults
      }]
    }
  };
}

const ANSI = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m' };

// Color is opt-in (TTY only, set by the CLI). Piped output stays byte-clean
// so `| jq`, CI logs, and byte-identical verdicts never see escape codes.
function paint(text, code, on) {
  return on ? `${code}${text}${ANSI.reset}` : text;
}

export function formatHuman(result, { summary = null, delta = null, receipt = null, staleReason = null, color = false } = {}) {
  const lines = [];
  if (summary) {
    const top = summary.top.map((t) => `${t.path} (+${t.added}/-${t.removed})`).join(', ');
    lines.push(`PR: ${summary.files} file(s), +${summary.added}/-${summary.removed}${top ? ` — top: ${top}` : ''}`);
  }
  lines.push(`HEAD: ${result.headSha}`);
  if (staleReason || result.verdict === 'STALE') {
    lines.push(paint(`STALE — ${staleReason || 'no verdict issued'}`, ANSI.yellow, color));
  } else if (result.blocking.length > 0) {
    lines.push(paint(`DO NOT SHIP — ${result.blocking.length} finding(s)`, ANSI.red, color));
    for (const f of result.blocking) {
      lines.push(`  ${f.file}:${f.line} [${f.ruleId}] ${f.evidence}`);
    }
  } else {
    lines.push(paint(`SHIP — 0 findings`, ANSI.green, color));
  }
  if (delta && (delta.new.length > 0 || delta.fixed.length > 0)) {
    const short = delta.prevHeadSha ? delta.prevHeadSha.slice(0, 7) : 'unknown';
    lines.push(`Since ${short}: +${delta.new.length} new, -${delta.fixed.length} fixed`);
    for (const f of delta.new) {
      lines.push(`  + ${f.file}:${f.line} [${f.ruleId}] ${f.evidence}`);
    }
    for (const f of delta.fixed) {
      lines.push(`  - ${f.file}:${f.line} [${f.ruleId}] ${f.evidence}`);
    }
  }
  if (result.silenced.length > 0) {
    lines.push(`Silenced (resolved): ${result.silenced.length}`);
    for (const f of result.silenced) {
      lines.push(`  ${f.file}:${f.line} [${f.ruleId}] (silenced)`);
    }
  }
  const nonBlocking = result.nonBlocking || [];
  if (nonBlocking.length > 0) {
    lines.push(`Advisory (non-blocking): ${nonBlocking.length}`);
    for (const f of nonBlocking) {
      lines.push(`  ${f.file}:${f.line} [${f.ruleId}] ${f.evidence}`);
    }
  }
  const excluded = result.excluded || [];
  if (excluded.length > 0) {
    lines.push(`Excluded by config: ${excluded.length}`);
    for (const f of excluded) {
      lines.push(`  ${f.file}:${f.line} [${f.ruleId}] (excluded)`);
    }
  }
  lines.push(`passed-checks: ${result.checksPassed}`);
  lines.push(`rule-pack: ${result.rulePackVersion}`);
  if (receipt) lines.push(`receipt: ${receipt.receipt_id}`);
  // Additive: verdict-override receipt line (present only when overridden).
  if (result.overridden) {
    lines.push(`OVERRIDDEN by ${result.overridden.actor} (${result.overridden.reason}) — was ${result.overridden.from}`);
  }
  return lines.join('\n');
}

// JSON machine surface per docs/data-model-v0.md: Review + Verdict + Findings.
export function toJson(result, { repo = null, prNumber = null, summary = null, delta = null, receipt = null } = {}) {
  const now = new Date().toISOString();
  return {
    review: {
      repo,
      prNumber,
      headSha: result.headSha,
      baseSha: result.baseSha,
      rulePackVersion: result.rulePackVersion,
      status: result.verdict === 'STALE' ? 'stale' : 'complete',
      completedAt: now,
    },
    verdict: {
      decision: result.verdict,
      headSha: result.headSha,
      baseSha: result.baseSha,
      rulePackVersion: result.rulePackVersion,
      issuedAt: now,
    },
    findings: {
      blocking: result.blocking,
      silenced: result.silenced,
      nonBlocking: result.nonBlocking || [],
      excluded: result.excluded || [],
    },
    summary,
    delta: delta ? {
      prevHeadSha: delta.prevHeadSha,
      new: delta.new,
      fixed: delta.fixed,
      carried: delta.carried,
    } : null,
    receipt,
    // Additive: present only when the verdict was overridden.
    ...(result.overridden ? { overridden: result.overridden, overriddenFrom: result.overriddenFrom } : {}),
    checksPassed: result.checksPassed,
  };
}

// Gov surface (sentinel.gov/0.1): the verdict expressed in the shape of
// Aftergraph ci-result/1.0 — one source's complete verdict for one exact
// SHA plus an environment fingerprint. Deltas from ci-result/1.0:
// verdict carried as a `sentinel/verdict` context entry (success/failure);
// STALE emitted as a single `cancelled` review entry, since the ci-result
// status enum has no stale state. See docs/receipts-v0.1.md.
export const GOV_CONTRACT = 'sentinel.gov/0.1';

export function toGov(result, { repo, prNumber, source, environment, runId, timestamp } = {}) {
  const now = timestamp || new Date().toISOString();
  const ruleIds = ruleIdsForPack(result.rulePackVersion);
  let results;
  if (result.verdict === 'STALE') {
    results = [{ context: 'sentinel/review', status: 'cancelled' }];
  } else {
    const fired = new Set(result.blocking.map((f) => f.ruleId));
    results = ruleIds.map((id) => ({
      context: `sentinel/${id}`,
      status: fired.has(id) ? 'failure' : 'success',
    }));
    results.push({
      context: 'sentinel/verdict',
      status: result.verdict === 'SHIP' ? 'success' : 'failure',
    });
  }
  return {
    contract: GOV_CONTRACT,
    repo: repo || null,
    prNumber: prNumber ?? null,
    sha: result.headSha,
    baseSha: result.baseSha,
    rulePackVersion: result.rulePackVersion,
    source,
    run_id: runId,
    attempt: 1,
    timestamp: now,
    environment: environment || null,
    results,
  };
}

export function readDiffInput(input) {
  if (input === '-') return readFileSync(0, 'utf8');
  try {
    return readFileSync(input, 'utf8');
  } catch {
    throw new Error(`Cannot read diff input: ${input}`);
  }
}

export function localHeadSha(diffText, explicit) {
  if (explicit) return explicit;
  return `local-${createHash('sha256').update(diffText).digest('hex').slice(0, 12)}`;
}

// Pure core shared by GitHub mode and --diff local mode: diff in,
// verdict + summary out. No network, no exit, no writes.
export async function analyzeDiff({ diffText, pack, excludePatterns = [], resolutions = new Set(), headSha, baseSha, override }) {
  const summary = summarizeDiff(diffText);
  const rules = await loadRules(pack);
  const rawFindings = [];
  for (const { check } of rules) rawFindings.push(...check(diffText));
  rawFindings.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 :
    a.line - b.line || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)
  );
  const { included, excluded } = filterExcluded(rawFindings, excludePatterns);
  const result = computeVerdict(included, resolutions, {
    headSha,
    baseSha,
    rulePackVersion: pack,
    // Additive: verdict override (absent unless the caller passes one).
    ...(override != null ? { override } : {}),
  }, excluded);
  return { result, summary };
}

export async function review({
  pr, repo: explicitRepo, format = 'human', memoryPath,
  rulePackVersion, source, ledgerPath, noLedger = false, configPath,
  diffInput, headSha: explicitHeadSha, baseSha: explicitBaseSha,
  override,
}) {
  if (!VALID_FORMATS.includes(format)) {
    throw new Error(`Unsupported format: ${format} (expected one of ${VALID_FORMATS.join(', ')})`);
  }
  const resolvedSource = source || detectSource();
  if (!SOURCE_ENUM.includes(resolvedSource)) {
    throw new Error(`Unsupported source: ${resolvedSource} (expected one of ${SOURCE_ENUM.join(', ')})`);
  }
  // CLI flag wins, then repo config, then the pack default.
  const { config, configHash } = loadConfig(configPath);
  const pack = rulePackVersion || config.rulePack || RULE_PACK_VERSION;
  // Color only on a live terminal, never in pipes: byte-identical verdicts.
  const useColor = format === 'human' && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const localMode = diffInput != null && diffInput !== '';

  let repo;
  let headSha;
  let baseShaStart;
  let diffText;
  if (localMode) {
    // Local mode: no GitHub, no auth. The verdict binds to --head-sha when
    // given (e.g. `git rev-parse HEAD` in a pre-push hook), else to a
    // content hash of the diff itself. Freshness has no remote to check.
    diffText = readDiffInput(diffInput);
    repo = explicitRepo || `local/${process.cwd().split(/[\\/]/).pop()}`;
    headSha = localHeadSha(diffText, explicitHeadSha);
    baseShaStart = explicitBaseSha || 'local-base';
  } else {
    repo = resolveRepo(explicitRepo);
    const prData = ghApi(`pulls/${pr}`, repo);
    headSha = prData.head.sha;
    baseShaStart = prData.base.sha;
    diffText = execSync(
      `gh api repos/${repo}/pulls/${pr} -H "Accept: application/vnd.github.v3.diff"`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
    );
  }

  const ledgerFile = ledgerPath || defaultLedgerPath();
  const chain = noLedger ? [] : loadLedger(ledgerFile);
  const prev = noLedger ? null : latestForRepoPr(chain, repo, pr);
  const prevHeadSha = prev && prev.headSha !== headSha ? prev.headSha : null;

  const environment = environmentInfo();
  const buildReceipt = (verdict, snap) => makeReceipt({
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

  // Freshness re-check: GitHub mode re-reads the PR; local mode has no
  // remote to drift, so the supplied (or content-bound) SHAs stand.
  let fresh = { fresh: true };
  if (!localMode) {
    const prDataCheck = ghApi(`pulls/${pr}`, repo);
    fresh = checkFreshness(
      { headSha, baseSha: baseShaStart },
      { headSha: prDataCheck.head.sha, baseSha: prDataCheck.base.sha },
    );
  }
  if (!fresh.fresh) {
    const staleResult = {
      verdict: 'STALE', headSha, baseSha: baseShaStart, rulePackVersion: pack,
      blocking: [], silenced: [], nonBlocking: [], excluded: [],
      checksPassed: ruleIdsForPack(pack).length,
    };
    const summary = summarizeDiff(diffText);
    const receipt = buildReceipt('STALE', { blocking: [], silenced: [], nonBlocking: [], excluded: [] });
    if (!noLedger) appendLedger(receipt, ledgerFile);
    emit(staleResult, { summary, delta: null, receipt, staleReason: fresh.reason });
    process.exit(2);
  }

  const resolutions = load(memoryPath);
  // Additive: an override rejection fails closed (no verdict); without an
  // override this block behaves exactly as before (analyzeDiff throws only
  // from rule loading, which still propagates).
  let result;
  let summary;
  try {
    ({ result, summary } = await analyzeDiff({
      diffText,
      pack,
      excludePatterns: config.exclude,
      resolutions,
      headSha,
      baseSha: baseShaStart,
      override,
    }));
  } catch (err) {
    if (override != null) {
      console.error(`Error: override rejected: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  const delta = prevHeadSha
    ? { prevHeadSha, ...computeDelta((prev.findings || {}).blocking, result.blocking) }
    : null;
  const snapshot = {
    blocking: result.blocking,
    silenced: result.silenced,
    nonBlocking: result.nonBlocking,
    excluded: result.excluded,
  };
  const receipt = buildReceipt(result.verdict, snapshot);
  if (!noLedger) appendLedger(receipt, ledgerFile);

  emit(result, { summary, delta, receipt });

  function emit(res, extra) {
    if (format === 'sarif') {
      console.log(JSON.stringify(toSarif(res), null, 2));
    } else if (format === 'json') {
      console.log(JSON.stringify(toJson(res, { repo, prNumber: pr, ...extra }), null, 2));
    } else if (format === 'gov') {
      console.log(JSON.stringify(toGov(res, {
        repo, prNumber: pr, source: resolvedSource, environment, runId: extra.receipt.run_id,
      }), null, 2));
    } else {
      console.log(formatHuman(res, {
        summary: extra.summary, delta: extra.delta, receipt: extra.receipt,
        staleReason: extra.staleReason, color: useColor,
      }));
    }
  }

  process.exit(result.verdict === 'SHIP' ? 0 : 1);
}

export function resolveFinding({ ruleId, file, evidence, headSha, reason, memoryPath }) {
  return memAppend({ ruleId, file, evidence, resolvingHeadSha: headSha, reason }, memoryPath);
}
