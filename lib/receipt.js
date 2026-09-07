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

import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

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
    findings,
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
    findings: rec.findings,
    counts: rec.counts,
    configHash: configHashOf(rec.configHash),
  };
  const recomputed = receiptIdFor(body);
  if (recomputed !== rec.receipt_id) {
    return { valid: false, reason: `receipt_id mismatch: expected ${recomputed}, got ${rec.receipt_id}` };
  }
  return { valid: true };
}

export function appendLedger(receipt, path = defaultLedgerPath()) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(receipt) + '\n');
  return receipt;
}

export function loadLedger(path = defaultLedgerPath()) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // ponytail: skip malformed lines rather than fail verification.
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
