import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clear, list } from '../lib/audit.js';
import { sealEvidence } from '../lib/evidence.js';
import { createEvidenceStore } from '../lib/evidence-store.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-evidence-'));
  return { dir, file: join(dir, 'evidence.json') };
}

function withTmp(fn) {
  return async (t) => {
    const { dir, file } = tmpFile();
    clear();
    try {
      await fn(t, file, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function input(over = {}) {
  return {
    runId: 'run-1',
    targetSha: SHA_A,
    type: 'repro',
    command: 'node repro.js',
    exitCode: 0,
    result: 'confirmed',
    artifacts: ['out/log.txt'],
    ...over,
  };
}

function tmpLeftovers(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.tmp'));
}

test('evidence-store: put/get round-trips a frozen item', withTmp(async (_t, file, dir) => {
  const store = createEvidenceStore(file);
  const sealed = sealEvidence(input());

  const stored = store.put(sealed);
  assert.equal(stored.id, sealed.id);
  assert.ok(Object.isFrozen(stored));

  const got = store.get(sealed.id);
  assert.ok(got !== null && got !== undefined);
  assert.deepEqual(got, sealed);
  assert.ok(Object.isFrozen(got));
  assert.ok(Object.isFrozen(got.artifactRefs));

  // Same id put twice stays a single entry (content-addressed).
  store.put(sealed);
  assert.equal(store.verifyAll().checked, 1);

  // Clean inventory.
  assert.deepEqual(store.verifyAll(), { ok: true, checked: 1, bad: [] });

  // File-backed + atomic: valid JSON, no tmp left behind.
  assert.equal(existsSync(file), true);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.items.length, 1);
  assert.equal(raw.items[0].id, sealed.id);
  assert.deepEqual(tmpLeftovers(dir), []);
}));

test('evidence-store: tampered or unsealed put throws (fail closed)', withTmp(async (_t, file) => {
  const store = createEvidenceStore(file);
  const sealed = sealEvidence(input());
  const before = list().length;

  // Shallow copy with a changed field: unfrozen AND hash-mismatched.
  assert.throws(() => store.put({ ...sealed, result: 'tampered' }), /unsealed|tampered/);
  // Frozen but hash-mismatched.
  assert.throws(() => store.put(Object.freeze({ ...sealed, result: 'tampered' })), /tampered/);
  // Frozen copy with a swapped id.
  assert.throws(
    () => store.put(Object.freeze({ ...sealed, id: '0'.repeat(64) })),
    /tampered/,
  );
  // Valid hash but not frozen (e.g. JSON round-trip): unsealed.
  const roundTripped = JSON.parse(JSON.stringify(sealed));
  assert.throws(() => store.put(roundTripped), /unsealed/);
  // Non-items.
  assert.throws(() => store.put(null), /sealed EvidenceItem/);
  assert.throws(() => store.put('nope'), /sealed EvidenceItem/);
  assert.throws(() => store.put([]), /sealed EvidenceItem/);

  // Rejected puts persist nothing and emit no audit.
  assert.equal(store.verifyAll().checked, 0);
  assert.equal(existsSync(file), false);
  assert.equal(list().length, before);
}));

test('evidence-store: get of a missing id returns null (never undefined)', withTmp(async (_t, file) => {
  const store = createEvidenceStore(file);
  store.put(sealEvidence(input()));
  assert.equal(store.get('0'.repeat(64)), null);
  assert.equal(store.get(''), null);
  assert.equal(store.get(null), null);
  assert.equal(store.get(undefined), null);
}));

test('evidence-store: listByRun + listByTarget indexes', withTmp(async (_t, file) => {
  const store = createEvidenceStore(file);
  const e1 = sealEvidence(input({ runId: 'run-1', targetSha: SHA_A }));
  const e2 = sealEvidence(input({ runId: 'run-1', targetSha: SHA_B }));
  const e3 = sealEvidence(input({ runId: 'run-2', targetSha: SHA_A }));
  store.put(e1);
  store.put(e2);
  store.put(e3);

  assert.deepEqual(store.listByRun('run-1').map((e) => e.id).sort(), [e1.id, e2.id].sort());
  assert.deepEqual(store.listByRun('run-2').map((e) => e.id), [e3.id]);
  assert.deepEqual(store.listByRun('run-missing'), []);
  assert.deepEqual(store.listByTarget(SHA_A).map((e) => e.id).sort(), [e1.id, e3.id].sort());
  assert.deepEqual(store.listByTarget(SHA_B).map((e) => e.id), [e2.id]);
  assert.deepEqual(store.listByTarget('c'.repeat(40)), []);
}));

test('evidence-store: verifyAll catches a hand-corrupted entry (inventory, not gate)', withTmp(
  async (_t, file) => {
    const store = createEvidenceStore(file);
    const good = sealEvidence(input({ runId: 'run-1' }));
    const victim = sealEvidence(input({ runId: 'run-2' }));
    store.put(good);
    store.put(victim);

    // Hand-corrupt one entry behind the store's back.
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.items.find((e) => e.id === victim.id).result = 'tampered';
    writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');

    const reloaded = createEvidenceStore(file);
    const report = reloaded.verifyAll();
    assert.equal(report.ok, false);
    assert.equal(report.checked, 2);
    assert.deepEqual(report.bad, [victim.id]);

    // Inventory, not gate: verifyAll never throws and get still serves.
    assert.ok(reloaded.get(victim.id) !== null);
    assert.equal(reloaded.get(good.id).result, 'confirmed');
  },
));

test('evidence-store: corrupt file throws fail-closed, never resets', withTmp(async (_t, file) => {
  writeFileSync(file, '{not json');
  assert.throws(() => createEvidenceStore(file), /corrupt store file/);
  assert.equal(readFileSync(file, 'utf8'), '{not json');

  writeFileSync(file, '["not", "an object"]');
  assert.throws(() => createEvidenceStore(file), /corrupt store file/);

  writeFileSync(file, JSON.stringify({ items: {} }));
  assert.throws(() => createEvidenceStore(file), /corrupt store file/);

  writeFileSync(file, JSON.stringify({ items: [null] }));
  assert.throws(() => createEvidenceStore(file), /corrupt store file/);

  assert.throws(() => createEvidenceStore(''), /requires filePath/);
}));

test('evidence-store: reload-from-disk round-trips', withTmp(async (_t, file) => {
  const store = createEvidenceStore(file);
  const a = sealEvidence(input({ runId: 'run-1', targetSha: SHA_A }));
  const b = sealEvidence(input({ runId: 'run-2', targetSha: SHA_B }));
  store.put(a);
  store.put(b);

  const again = createEvidenceStore(file);
  assert.deepEqual(again.get(a.id), a);
  assert.deepEqual(again.get(b.id), b);
  assert.deepEqual(again.listByRun('run-1').map((e) => e.id), [a.id]);
  assert.deepEqual(again.listByTarget(SHA_B).map((e) => e.id), [b.id]);
  assert.deepEqual(again.verifyAll(), { ok: true, checked: 2, bad: [] });

  // reload() picks up writes made through another handle.
  const third = createEvidenceStore(file);
  third.put(sealEvidence(input({ runId: 'run-3' })));
  assert.equal(store.verifyAll().checked, 2);
  store.reload();
  assert.equal(store.verifyAll().checked, 3);
}));

test('evidence-store: every put emits an audit event', withTmp(async (_t, file) => {
  const store = createEvidenceStore(file);
  const a = sealEvidence(input({ runId: 'run-1' }));
  const b = sealEvidence(input({ runId: 'run-2' }));

  store.put(a);
  let events = list();
  assert.equal(events.length, 1);
  assert.match(events[0].type, /evidence/);
  assert.equal(events[0].to, a.id);

  store.put(b);
  events = list();
  assert.equal(events.length, 2);
  assert.equal(events[1].to, b.id);
}));
