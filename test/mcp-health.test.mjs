import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOLS, dispatch, handleMessage } from '../mcp/sentinel-mcp.js';
import { makeReceipt, appendLedger, verifyReceipt } from '../lib/receipt.js';
import { RULE_PACK_VERSION } from '../lib/rulepack.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'sentinel-mcp-health-'));
}

function bodyOf(out) {
  return JSON.parse(out.content[0].text);
}

const EMPTY_FINDINGS = { blocking: [], silenced: [], nonBlocking: [], excluded: [] };
const EMPTY_COUNTS = { blocking: 0, silenced: 0, nonBlocking: 0, excluded: 0 };

function seedLedger(file) {
  const rec1 = appendLedger(makeReceipt({
    repo: 'ship/repo', prNumber: 1, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
    rulePackVersion: RULE_PACK_VERSION, verdict: 'SHIP',
    findings: EMPTY_FINDINGS, counts: EMPTY_COUNTS,
    configHash: null, source: 'manual', environment: null, prevReceiptId: null,
  }), file);
  const blocking = [{ ruleId: 'no-eval-with-dynamic-input', file: 'srv/app.js', line: 2, evidence: 'eval(x)' }];
  const rec2 = appendLedger(makeReceipt({
    repo: 'block/repo', prNumber: 2, headSha: 'c'.repeat(40), baseSha: 'd'.repeat(40),
    rulePackVersion: RULE_PACK_VERSION, verdict: 'DO_NOT_SHIP',
    findings: { blocking, silenced: [], nonBlocking: [], excluded: [] },
    counts: { blocking: 1, silenced: 0, nonBlocking: 0, excluded: 0 },
    configHash: null, source: 'manual', environment: null, prevReceiptId: null,
  }), file);
  return { rec1, rec2 };
}

function tamperFirstLine(file) {
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  const rec = JSON.parse(lines[0]);
  rec.verdict = rec.verdict === 'SHIP' ? 'DO_NOT_SHIP' : 'SHIP';
  lines[0] = JSON.stringify(rec);
  writeFileSync(file, `${lines.join('\n')}\n`);
}

test('mcp-health: tools/list exposes the 2 new read-only tools after the original 12', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 401, method: 'tools/list' });
  const names = res.result.tools.map((t) => t.name);
  const original12 = [
    'sentinel_review', 'sentinel_rules_list', 'sentinel_verdict_latest',
    'sentinel_receipt_verify', 'sentinel_config_show', 'sentinel_finding_lifecycle',
    'sentinel_verify_plan', 'sentinel_policy_evaluate',
    'sentinel_orgs_list', 'sentinel_org_repos', 'sentinel_evidence_get', 'sentinel_evidence_verify',
  ];
  // Existing catalog order untouched: the 12 come first, in order.
  assert.deepEqual(names.slice(0, 12), original12);
  assert.ok(names.includes('sentinel_health_verdicts'), 'missing sentinel_health_verdicts');
  assert.ok(names.includes('sentinel_ledger_verify'), 'missing sentinel_ledger_verify');
  assert.equal(TOOLS.length, 14);
  assert.ok(!names.some((n) => /fix|approve|push|write|exec|runLocal/i.test(n)), 'no write/exec tools');
});

test('mcp-health: health_verdicts seeded-ledger totals + top rules with echo', async () => {
  const dir = tmpDir();
  try {
    const file = join(dir, 'ledger.jsonl');
    seedLedger(file);
    const beforeBytes = readFileSync(file, 'utf8');

    const out = await dispatch('sentinel_health_verdicts', { ledgerPath: file });
    assert.equal(out.isError, undefined);
    const body = bodyOf(out);
    assert.equal(body.ledgerPath, file);
    assert.deepEqual(body.totals, { SHIP: 1, DO_NOT_SHIP: 1, STALE: 0, BLOCKED: 0, OVERRIDDEN: 0 });
    assert.equal(body.policyOverrides, 0);
    assert.equal(body.window.receipts, 2);
    assert.equal(typeof body.window.since, 'string');
    const top = body.byRule.find((e) => e.ruleId === 'no-eval-with-dynamic-input');
    assert.ok(top, 'expected blocking rule in byRule');
    assert.equal(top.count, 1);
    assert.deepEqual(body.topRules, body.byRule);
    // Read-only: no file writes.
    assert.equal(readFileSync(file, 'utf8'), beforeBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp-health: ledger_verify clean chain ok:true via lib/receipt.js verifier', async () => {
  const dir = tmpDir();
  try {
    const file = join(dir, 'ledger.jsonl');
    const { rec1, rec2 } = seedLedger(file);
    // Sanity: the same lib verifier the tool imports accepts both receipts.
    assert.equal(verifyReceipt(rec1).valid, true);
    assert.equal(verifyReceipt(rec2).valid, true);
    const beforeBytes = readFileSync(file, 'utf8');

    const out = await dispatch('sentinel_ledger_verify', { ledgerPath: file });
    assert.equal(out.isError, undefined);
    const body = bodyOf(out);
    assert.equal(body.ledgerPath, file);
    assert.deepEqual({ ok: body.ok, checked: body.checked, bad: body.bad }, { ok: true, checked: 2, bad: [] });
    assert.equal(readFileSync(file, 'utf8'), beforeBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp-health: ledger_verify tampered ledger ok:false with bad id', async () => {
  const dir = tmpDir();
  try {
    const file = join(dir, 'ledger.jsonl');
    const { rec1 } = seedLedger(file);
    tamperFirstLine(file);

    const out = await dispatch('sentinel_ledger_verify', { ledgerPath: file });
    assert.equal(out.isError, undefined);
    const body = bodyOf(out);
    assert.equal(body.ledgerPath, file);
    assert.equal(body.ok, false);
    assert.equal(body.checked, 2);
    assert.ok(Array.isArray(body.bad));
    assert.ok(body.bad.includes(rec1.receipt_id), `bad should include ${rec1.receipt_id}`);

    const viaRpc = await handleMessage({
      jsonrpc: '2.0', id: 402, method: 'tools/call',
      params: { name: 'sentinel_ledger_verify', arguments: { ledgerPath: file } },
    });
    assert.equal(viaRpc.result.isError, undefined);
    assert.ok(JSON.parse(viaRpc.result.content[0].text).bad.includes(rec1.receipt_id));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp-health: missing file returns isError with echo, never throws', async () => {
  const dir = tmpDir();
  try {
    const missing = join(dir, 'nope.jsonl');
    const h = await dispatch('sentinel_health_verdicts', { ledgerPath: missing });
    assert.equal(h.isError, true);
    assert.equal(bodyOf(h).ledgerPath, missing);
    assert.match(bodyOf(h).error, /not found/i);

    const v = await dispatch('sentinel_ledger_verify', { ledgerPath: missing });
    assert.equal(v.isError, true);
    assert.equal(bodyOf(v).ledgerPath, missing);
    assert.match(bodyOf(v).error, /not found/i);

    const viaRpc = await handleMessage({
      jsonrpc: '2.0', id: 403, method: 'tools/call',
      params: { name: 'sentinel_health_verdicts', arguments: { ledgerPath: missing } },
    });
    assert.equal(viaRpc.result.isError, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp-health: ledgerPath is required on both tools (no default probing)', async () => {
  for (const [name, args] of [
    ['sentinel_health_verdicts', {}],
    ['sentinel_health_verdicts', { ledgerPath: '' }],
    ['sentinel_health_verdicts', { ledgerPath: null }],
    ['sentinel_ledger_verify', {}],
    ['sentinel_ledger_verify', { ledgerPath: '   ' }],
    ['sentinel_ledger_verify', { ledgerPath: null }],
  ]) {
    const out = await dispatch(name, args);
    assert.equal(out.isError, true, `${name} ${JSON.stringify(args)} must be isError`);
    assert.match(bodyOf(out).error, /ledgerPath/);
  }
});

test('mcp-health: existing tools untouched (rules + verify plan still match lib)', async () => {
  const rules = bodyOf(await dispatch('sentinel_rules_list', {}));
  assert.ok(rules.rules.length > 0);
  assert.equal(rules.rules.find((r) => r.id === 'no-eval-with-dynamic-input').severity, 'security');
});
