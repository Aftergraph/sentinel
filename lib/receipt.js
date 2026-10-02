// Verdict receipts + local claim ledger — sentinel.receipt/0.1.
//
// Every review emits a content-addressed receipt: receipt_id is the sha256
// of the canonical receipt body, so identical inputs (same HEAD, pack,
// findings) always yield the identical id. Receipts chain per repo+PR via
// prev_receipt_id in an append-only JSONL ledger.
//
// Evidence-layer honesty: this ledger is a LOCAL claim log. It is not L1
// action audit and not an L2 execution quittance — it upgrades no platform
// evidence layer. It proves what this runner computed, nothing more.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const RECEIPT_CONTRACT = 'sentinel.receipt/0.1';

// Same enum as Aftergraph exact-head-truth/1.0 + ci-result/1.0 sources.
export const SOURCE_ENUM = ['github-actions', 'self-hosted', 'works-control-plane', 'manual', 'agent'];

export function defaultLedgerPath() {
  return join(homedir(), '.sentinel', 'ledger.jsonl');
}

export function detectSource() {
  return process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'manual';
}

export function receiptIdFor(body) {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function configHashOf(value) {
  return value == null ? null : value;
}

// Advisory blast-radius context (`blastContext` on findings, S2 slice 2)
// MUST NOT enter receipt hashes or stored snapshots: it is non-verdict
// display data. Stripped here (and in verifyReceipt) so the same verdict
// yields the identical receipt_id with or without context attached.
function stripBlastContext(findings) {
  if (!findings || typeof findings !== 'object' || Array.isArray(findings)) return findings;
  const out = { ...findings };
  for (const k of ['blocking', 'silenced', 'nonBlocking', 'excluded']) {
    const list = out[k];
    if (Array.isArray(list)) {
      out[k] = list.map((f) => {
        if (!f || typeof f !== 'object' || !('blastContext' in f)) return f;
        const { blastContext: _dropped, ...rest } = f;
        return rest;
      });
    }
  }
  return out;
}

// findings MUST be passed in fixed key order {blocking, silenced,
// nonBlocking, excluded} so the hash is stable.
export function makeReceipt({
  repo, prNumber, headSha, baseSha, rulePackVersion, verdict,
  findings, counts, configHash, source, environment, prevReceiptId,
  runId, timestamp, overridden, overriddenFrom, policyEvaluation,
}) {
  const body = {
    contract: RECEIPT_CONTRACT,
    repo,
    prNumber,
    headSha,
    baseSha,
    rulePackVersion,
    verdict,
    findings: stripBlastContext(findings),
    counts,
    configHash: configHashOf(configHash),
  };
  // Attestation passthrough (outside the hashed body: old receipt ids and
  // verifyReceipt are unaffected — see body reconstruction in verifyReceipt).
  const attestation = {
    ...(overridden != null ? { overridden } : {}),
    ...(overriddenFrom != null ? { overriddenFrom } : {}),
    ...(policyEvaluation != null ? { policyEvaluation } : {}),
  };
  return {
    ...body,
    ...attestation,
    receipt_id: receiptIdFor(body),
    prev_receipt_id: prevReceiptId || null,
    run_id: runId || randomUUID(),
    timestamp: timestamp || new Date().toISOString(),
    source,
    environment: environment || null,
  };
}

export function verifyReceipt(rec) {
  if (!rec || typeof rec !== 'object') return { valid: false, reason: 'not an object' };
  const required = ['contract', 'repo', 'prNumber', 'headSha', 'baseSha', 'rulePackVersion',
    'verdict', 'findings', 'counts', 'receipt_id', 'timestamp', 'source'];
  for (const k of required) {
    if (!(k in rec)) return { valid: false, reason: `missing field: ${k}` };
  }
  if (rec.contract !== RECEIPT_CONTRACT) return { valid: false, reason: `unknown contract: ${rec.contract}` };
  const body = {
    contract: rec.contract,
    repo: rec.repo,
    prNumber: rec.prNumber,
    headSha: rec.headSha,
    baseSha: rec.baseSha,
    rulePackVersion: rec.rulePackVersion,
    verdict: rec.verdict,
    findings: stripBlastContext(rec.findings),
    counts: rec.counts,
    configHash: configHashOf(rec.configHash),
  };
  const recomputed = receiptIdFor(body);
  if (recomputed !== rec.receipt_id) {
    return { valid: false, reason: `receipt_id mismatch: expected ${recomputed}, got ${rec.receipt_id}` };
  }
  return { valid: true };
}

// The ledger is append-only evidence, so it must not be truncated in place.
// Growth is bounded by rotating whole generations: `path` stays the active
// segment, older ones move to `path.1`, `path.2`, … and the oldest is dropped
// once MAX_LEDGER_GENERATIONS is reached. The tmp+rename write below is kept
// exactly as it was (O_APPEND is not atomic for lines larger than PIPE_BUF).
export const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
export const MAX_LEDGER_GENERATIONS = 5;

export function rotateLedgerIfNeeded(path, maxBytes = MAX_LEDGER_BYTES, generations = MAX_LEDGER_GENERATIONS) {
  if (!existsSync(path)) return false;
  if (statSync(path).size < maxBytes) return false;
  // Drop the oldest generation, then shift the rest down one slot.
  const oldest = `${path}.${generations - 1}`;
  if (existsSync(oldest)) rmSync(oldest, { force: true });
  for (let g = generations - 2; g >= 1; g -= 1) {
    const from = `${path}.${g}`;
    if (existsSync(from)) renameSync(from, `${path}.${g + 1}`);
  }
  renameSync(path, `${path}.1`);
  return true;
}

export function appendLedger(receipt, path = defaultLedgerPath()) {
  mkdirSync(dirname(path), { recursive: true });
  // Atomic append: write to tmp then rename to prevent corruption under concurrency.
  const line = JSON.stringify(receipt) + '\n';
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, existing + line);
  renameSync(tmp, path);
  rotateLedgerIfNeeded(path);
  return receipt;
}

// loadLedger reads the active segment plus any rotated generations, oldest
// first, so callers still observe a continuous history across a rotation.
export function loadLedgerPaths(path = defaultLedgerPath()) {
  const paths = [];
  for (let g = MAX_LEDGER_GENERATIONS - 1; g >= 1; g -= 1) {
    const p = `${path}.${g}`;
    if (existsSync(p)) paths.push(p);
  }
  if (existsSync(path)) paths.push(path);
  return paths;
}

export function loadLedger(path = defaultLedgerPath()) {
  const out = [];
  for (const p of loadLedgerPaths(path)) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // ponytail: skip malformed lines rather than fail verification.
      }
    }
  }
  return out;
}

export function latestForRepoPr(entries, repo, prNumber) {
  let latest = null;
  for (const e of entries) {
    if (e.repo === repo && e.prNumber === prNumber) latest = e;
  }
  return latest;
}
