import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOLS, dispatch, handleMessage } from '../mcp/sentinel-mcp.js';
import { createOrgStore } from '../lib/org-store.js';
import { createEvidenceStore } from '../lib/evidence-store.js';
import { sealEvidence } from '../lib/evidence.js';
import { list as auditList, clear as auditClear } from '../lib/audit.js';
import { RULE_PACK_VERSION } from '../lib/rulepack.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'sentinel-mcp-org-'));
}

function bodyOf(out) {
  return JSON.parse(out.content[0].text);
}

function seedOrgStore(file) {
  const store = createOrgStore(file);
  const orgA = store.createOrg('Acme');
  const orgB = store.createOrg('Globex');
  const wsA = store.createWorkspace(orgA.id, 'Eng');
  const r1 = store.linkRepo({ orgId: orgA.id, workspaceId: wsA.id, fullName: 'acme/api', installationId: 11 });
  const r2 = store.linkRepo({ orgId: orgA.id, workspaceId: wsA.id, fullName: 'acme/web', installationId: 12 });
  return { store, orgA, orgB, wsA, r1, r2 };
}

function seedEvidenceStore(file) {
  const store = createEvidenceStore(file);
  const e1 = store.put(sealEvidence({
    runId: 'run-1', targetSha: SHA_A, type: 'repro',
    command: 'node repro.js', exitCode: 0, result: 'confirmed', artifacts: ['out/log.txt'],
  }));
  const e2 = store.put(sealEvidence({
    runId: 'run-2', targetSha: SHA_B, type: 'sast',
    command: 'node scan.js', exitCode: 1, result: 'clean', artifacts: [],
  }));
  return { store, e1, e2 };
}

function tamperEvidenceFile(file, victimId) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.items.find((e) => e.id === victimId).result = 'tampered';
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
}

test('mcp-org: tools/list exposes the 4 new read-only tools next to the original 8', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 301, method: 'tools/list' });
  const names = res.result.tools.map((t) => t.name);
  const original8 = [
    'sentinel_review', 'sentinel_rules_list', 'sentinel_verdict_latest',
    'sentinel_receipt_verify', 'sentinel_config_show', 'sentinel_finding_lifecycle',
    'sentinel_verify_plan', 'sentinel_policy_evaluate',
  ];
  for (const n of original8) assert.ok(names.includes(n), `missing original ${n}`);
  // Original catalog order untouched: the 8 come first, in order.
  assert.deepEqual(names.slice(0, 8), original8);
  for (const n of ['sentinel_orgs_list', 'sentinel_org_repos', 'sentinel_evidence_get', 'sentinel_evidence_verify']) {
    assert.ok(names.includes(n), `missing ${n}`);
  }
  assert.equal(TOOLS.length, 12);
  assert.ok(!names.some((n) => /fix|approve|push|write|exec|runLocal/i.test(n)), 'no write/exec tools');
});

test('mcp-org: orgs_list happy path against a seeded tmp store', async () => {
  const dir = tmpDir();
  try {
    const file = join(dir, 'orgs.json');
    const { orgA, orgB } = seedOrgStore(file);
    auditClear();
    const beforeBytes = readFileSync(file, 'utf8');
    const beforeAudit = auditList().length;

    const out = await dispatch('sentinel_orgs_list', { storePath: file });
    assert.equal(out.isError, undefined);
    const body = bodyOf(out);
    assert.equal(body.storePath, file);
    assert.equal(body.count, 2);
    assert.deepEqual(body.orgs, [
      { id: orgA.id, name: 'Acme' },
      { id: orgB.id, name: 'Globex' },
    ]);
    // Read-only: no file writes, no audit events.
    assert.equal(readFileSync(file, 'utf8'), beforeBytes);
    assert.equal(auditList().length, beforeAudit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp-org: orgs_list missing/corrupt file returns isError, never throws', async () => {
  const dir = tmpDir();
  try {
    const missing = join(dir, 'nope.json');
    const out = await dispatch('sentinel_orgs_list', { storePath: missing });
    assert.equal(out.isError, true);
    const body = bodyOf(out);
    assert.equal(body.storePath, missing);
    assert.equal(body.count, 0);
    assert.match(body.error, /not found/i);

    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{not json');
    const bad = await dispatch('sentinel_orgs_list', { storePath: corrupt });
    assert.equal(bad.isError, true);
    assert.match(bodyOf(bad).error, /corrupt/i);

    const viaRpc = await handleMessage({
      jsonrpc: '2.0', id: 302, method: 'tools/call',
      params: { name: 'sentinel_orgs_list', arguments: { storePath: missing } },
    });
    assert.equal(viaRpc.result.isError, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp-org: org_repos happy path lists linked repos with echo + counts', async () => {
  const dir = tmpDir();
  try {
    const file = join(dir, 'orgs.json');
    const { orgA, orgB, r1, r2 } = seedOrgStore(file);

    const out = await dispatch('sentinel_org_repos', { storePath: file, orgId: orgA.id });
    assert.equal(out.isError, undefined);
    const body = bodyOf(out);
    assert.equal(body.storePath, file);
    assert.equal(body.orgId, orgA.id);
    assert.equal(body.count, 2);
    assert.deepEqual(body.repos.map((r) => r.fullName).sort(), ['acme/api', 'acme/web']);
    assert.deepEqual(body.repos.map((r) => r.id).sort(), [r1.id, r2.id].sort());

    const empty = bodyOf(await dispatch('sentinel_org_repos', { storePath: file, orgId: orgB.id }));
    assert.equal(empty.count, 0);
    assert.deepEqual(empty.repos, []);
    assert.equal(empty.storePath, file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp-org: org_repos unknown org and bad input return isError', async () => {
  const dir = tmpDir();
  try {
    const file = join(dir, 'orgs.json');
    seedOrgStore(file);

    const unknown = await dispatch('sentinel_org_repos', { storePath: file, orgId: 'org_missing' });
    assert.equal(unknown.isError, true);
    assert.match(bodyOf(unknown).error, /unknown org.*org_missing/);

    const noOrg = await dispatch('sentinel_org_repos', { storePath: file });
    assert.equal(noOrg.isError, true);

    const viaRpc = await handleMessage({
      jsonrpc: '2.0', id: 303, method: 'tools/call',
      params: { name: 'sentinel_org_repos', arguments: { storePath: file, orgId: 'org_missing' } },
    });
    assert.equal(viaRpc.result.isError, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp-org: evidence_get happy path returns sealed item + valid revalidation', async () => {
  const dir = tmpDir();
  try {
    const file = join(dir, 'evidence.json');
    const { e1 } = seedEvidenceStore(file);

    const out = await dispatch('sentinel_evidence_get', { storePath: file, id: e1.id });
    assert.equal(out.isError, undefined);
    const body = bodyOf(out);
    assert.equal(body.storePath, file);
    assert.equal(body.id, e1.id);
    assert.equal(body.valid, true);
    assert.equal(body.count, 1);
    assert.equal(body.item.id, e1.id);
    assert.equal(body.item.outputHash, e1.outputHash);
    assert.equal(body.item.result, 'confirmed');
    assert.deepEqual(body.item.artifactRefs, ['out/log.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp-org: evidence_get tampered entry returns isError naming the id', async () => {
  const dir = tmpDir();
  try {
    const file = join(dir, 'evidence.json');
    const { e1 } = seedEvidenceStore(file);
    tamperEvidenceFile(file, e1.id);

    // dispatch must resolve with isError (never reject).
    const out = await dispatch('sentinel_evidence_get', { storePath: file, id: e1.id });
    assert.equal(out.isError, true);
    const body = bodyOf(out);
    assert.ok(body.error.includes(e1.id), 'tampered error must list the id');
    assert.match(body.error, /tampered/i);
    assert.equal(body.storePath, file);

    const unknown = await dispatch('sentinel_evidence_get', { storePath: file, id: '0'.repeat(64) });
    assert.equal(unknown.isError, true);

    const viaRpc = await handleMessage({
      jsonrpc: '2.0', id: 304, method: 'tools/call',
      params: { name: 'sentinel_evidence_get', arguments: { storePath: file, id: e1.id } },
    });
    assert.equal(viaRpc.result.isError, true);
    assert.ok(JSON.parse(viaRpc.result.content[0].text).error.includes(e1.id));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp-org: evidence_verify returns verifyAll summary shape', async () => {
  const dir = tmpDir();
  try {
    const file = join(dir, 'evidence.json');
    const { e2 } = seedEvidenceStore(file);

    const clean = bodyOf(await dispatch('sentinel_evidence_verify', { storePath: file }));
    assert.deepEqual({ ok: clean.ok, checked: clean.checked, bad: clean.bad },
      { ok: true, checked: 2, bad: [] });
    assert.equal(clean.storePath, file);
    assert.equal(clean.count, 2);

    tamperEvidenceFile(file, e2.id);
    const dirty = bodyOf(await dispatch('sentinel_evidence_verify', { storePath: file }));
    assert.equal(dirty.ok, false);
    assert.equal(dirty.checked, 2);
    assert.deepEqual(dirty.bad, [e2.id]);
    assert.equal(dirty.count, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp-org: evidence tools missing-file and corrupt-file return isError', async () => {
  const dir = tmpDir();
  try {
    const missing = join(dir, 'nope.json');
    const e1 = await dispatch('sentinel_evidence_get', { storePath: missing, id: '0'.repeat(64) });
    assert.equal(e1.isError, true);
    const v1 = await dispatch('sentinel_evidence_verify', { storePath: missing });
    assert.equal(v1.isError, true);

    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '["not", "an object"]');
    const e2 = await dispatch('sentinel_evidence_get', { storePath: corrupt, id: '0'.repeat(64) });
    assert.equal(e2.isError, true);
    assert.match(bodyOf(e2).error, /corrupt/i);
    const v2 = await dispatch('sentinel_evidence_verify', { storePath: corrupt });
    assert.equal(v2.isError, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mcp-org: storePath is required on all four tools (no default probing)', async () => {
  for (const [name, args] of [
    ['sentinel_orgs_list', {}],
    ['sentinel_orgs_list', { storePath: '' }],
    ['sentinel_org_repos', { orgId: 'org_x' }],
    ['sentinel_evidence_get', { id: '0'.repeat(64) }],
    ['sentinel_evidence_verify', {}],
    ['sentinel_evidence_verify', { storePath: null }],
  ]) {
    const out = await dispatch(name, args);
    assert.equal(out.isError, true, `${name} ${JSON.stringify(args)} must be isError`);
    assert.match(bodyOf(out).error, /storePath/);
  }
});

test('mcp-org: existing tools untouched (rules + verify plan still match lib)', async () => {
  const rules = bodyOf(await dispatch('sentinel_rules_list', {}));
  assert.ok(rules.rules.length > 0);
  assert.equal(rules.rules.find((r) => r.id === 'no-eval-with-dynamic-input').severity, 'security');

  const plan = bodyOf(await dispatch('sentinel_verify_plan', { ruleId: 'no-eval-with-dynamic-input' }));
  assert.equal(plan.ruleId, 'no-eval-with-dynamic-input');
  assert.equal(plan.rulePackVersion, RULE_PACK_VERSION);
  assert.ok(plan.checks.length > 0);
});
