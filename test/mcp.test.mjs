import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TOOLS, dispatch, handleMessage, createFramer, frame,
} from '../mcp/sentinel-mcp.js';
import { makeReceipt, appendLedger } from '../lib/receipt.js';
import { RULE_PACK_VERSION } from '../lib/rulepack.js';

const EVAL_DIFF = `diff --git a/srv/app.js b/srv/app.js
index 1111111..2222222 100644
--- a/srv/app.js
+++ b/srv/app.js
@@ -1,3 +1,4 @@
 export function run(input) {
+  return eval(input);
 }
`;

test('mcp: initialize handshake', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.equal(res.result.capabilities.tools !== undefined, true);
  assert.equal(res.result.serverInfo.name, 'sentinel');
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('mcp: tools/list exposes the read-only catalog', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = res.result.tools.map((t) => t.name);
  assert.ok(names.includes('sentinel_review'));
  assert.ok(names.includes('sentinel_rules_list'));
  assert.ok(names.includes('sentinel_verdict_latest'));
  assert.ok(names.includes('sentinel_receipt_verify'));
  assert.ok(names.includes('sentinel_config_show'));
  assert.ok(!names.some((n) => /fix|approve|push|write/i.test(n)), 'no write tools');
});

test('mcp: unknown method and malformed input', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'nope/nothing' });
  assert.equal(res.error.code, -32601);
  const bad = await handleMessage({ method: 'tools/list' });
  assert.equal(bad.error.code, -32600);
  const unknownTool = await handleMessage({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'sentinel_fix_it', arguments: {} },
  });
  assert.equal(unknownTool.error.code, -32602);
});

test('mcp: sentinel_review on a dirty diff', async () => {
  const res = await handleMessage({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'sentinel_review', arguments: { diff: EVAL_DIFF } },
  });
  const body = JSON.parse(res.result.content[0].text);
  assert.equal(body.verdict, 'DO_NOT_SHIP');
  assert.equal(body.blocking[0].ruleId, 'no-eval-with-dynamic-input');
  assert.equal(body.rulePack, RULE_PACK_VERSION);
});

test('mcp: sentinel_review errors without input', async () => {
  const res = await handleMessage({
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'sentinel_review', arguments: {} },
  });
  assert.equal(res.result.isError, true);
});

test('mcp: PR mode validates repo shape before shelling out', async () => {
  const res = await handleMessage({
    jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'sentinel_review', arguments: { repo: 'o/r; rm -rf /', pr: 7 } },
  });
  assert.equal(res.result.isError, true);
  assert.ok(JSON.parse(res.result.content[0].text).error.includes('owner/name'));
});

test('mcp: rules list carries severities + blocking flags', async () => {
  const out = await dispatch('sentinel_rules_list', {});
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.rules.length, 20);
  const evalRule = body.rules.find((r) => r.id === 'no-eval-with-dynamic-input');
  assert.equal(evalRule.severity, 'security');
  assert.equal(evalRule.blocks, true);
  const varRule = body.rules.find((r) => r.id === 'no-var-instead-of-let-const');
  assert.equal(varRule.blocks, false);
});

test('mcp: verdict_latest + receipt_verify round-trip over temp ledger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-mcp-'));
  try {
    const ledger = join(dir, 'ledger.jsonl');
    const rec = appendLedger(makeReceipt({
      repo: 'o/r', prNumber: 3, headSha: 'h'.repeat(40), baseSha: 'b'.repeat(40),
      rulePackVersion: RULE_PACK_VERSION, verdict: 'SHIP',
      findings: { blocking: [], silenced: [], nonBlocking: [], excluded: [] },
      counts: { blocking: 0, silenced: 0, nonBlocking: 0, excluded: 0 },
      configHash: null, source: 'manual', environment: null, prevReceiptId: null,
    }), ledger);
    const latest = await dispatch('sentinel_verdict_latest', { repo: 'o/r', pr: 3, ledgerPath: ledger });
    assert.equal(JSON.parse(latest.content[0].text).receipt.receipt_id, rec.receipt_id);
    const empty = await dispatch('sentinel_verdict_latest', { repo: 'o/r', pr: 99, ledgerPath: ledger });
    assert.equal(JSON.parse(empty.content[0].text).receipt, null);
    const v = await dispatch('sentinel_receipt_verify', { receipt: rec });
    assert.equal(JSON.parse(v.content[0].text).valid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp: framing splits concatenated messages and waits for partials', () => {
  const framer = createFramer();
  const a = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const b = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
  const both = Buffer.concat([frame(a), frame(b)]);
  assert.equal(framer.push(both).length, 2);
  const framer2 = createFramer();
  const half = frame(a);
  assert.equal(framer2.push(half.subarray(0, 10)).length, 0);
  assert.equal(framer2.push(half.subarray(10)).length, 1);
});

test('mcp: stdio loop serves a real session', async () => {
  const { spawnSync } = await import('node:child_process');
  const req = frame({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
  const child = spawnSync(process.execPath, ['mcp/sentinel-mcp.js'], { input: req, encoding: 'buffer' });
  assert.equal(child.status, 0);
  const framer = createFramer();
  const msgs = framer.push(child.stdout);
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].result.tools.length >= 5);
});
