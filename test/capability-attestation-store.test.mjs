import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCapabilityAttestationStore,
  freshnessState,
  validateCapabilityAttestation,
} from '../lib/capability-attestation-store.js';

const attestation = (overrides = {}) => ({
  id: 'capatt_lenovo_computer_1',
  nodeId: 'wrkr_jonas_lenovo',
  capability: 'computer',
  state: 'AVAILABLE',
  observedAt: '2026-10-06T18:00:00.000Z',
  verifiedAt: '2026-10-06T18:00:05.000Z',
  freshnessTtlMs: 60_000,
  source: 'sentinel:computer-probe',
  ...overrides,
});

test('capability attestation store validates exact runtime-fabric shape', () => {
  assert.equal(validateCapabilityAttestation(attestation()), true);
  assert.equal(validateCapabilityAttestation({ ...attestation(), extra: true }), false);
  assert.equal(validateCapabilityAttestation({ ...attestation(), freshnessTtlMs: 0 }), false);
  assert.equal(
    validateCapabilityAttestation({
      ...attestation(),
      observedAt: '2026-10-06T18:01:00.000Z',
      verifiedAt: '2026-10-06T18:00:05.000Z',
    }),
    false,
  );
});

test('capability attestation store persists and queries deterministically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-capatt-'));
  try {
    const path = join(dir, 'attestations.json');
    const store = createCapabilityAttestationStore(path);
    store.put(attestation({ id: 'z', capability: 'local.device' }));
    store.put(attestation({ id: 'a', capability: 'computer' }));
    store.put(attestation({
      id: 'other',
      nodeId: 'wrkr_vds_1',
      capability: 'browser',
    }));

    const out = store.query({
      nodeIds: ['wrkr_jonas_lenovo'],
      capabilities: ['local.device', 'computer'],
      nowMs: Date.parse('2026-10-06T18:00:30.000Z'),
    });

    assert.deepEqual(out.map((item) => [item.id, item.capability]), [
      ['a', 'computer'],
      ['z', 'local.device'],
    ]);

    const reopened = createCapabilityAttestationStore(path);
    assert.equal(
      reopened.query({
        nodeIds: ['wrkr_vds_1'],
        capabilities: ['browser'],
        nowMs: Date.parse('2026-10-06T18:00:30.000Z'),
      })[0].id,
      'other',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capability attestation freshness fails closed to STALE', () => {
  const available = attestation();
  assert.equal(
    freshnessState(available, Date.parse('2026-10-06T18:00:30.000Z')),
    'AVAILABLE',
  );
  assert.equal(
    freshnessState(available, Date.parse('2026-10-06T18:01:06.000Z')),
    'STALE',
  );
  assert.equal(
    freshnessState(attestation({ state: 'REVOKED' }), Date.parse('2026-10-06T18:00:30.000Z')),
    'REVOKED',
  );
});
