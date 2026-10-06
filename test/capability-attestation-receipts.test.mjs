import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attestationsFromCapabilityReceipt,
  ingestCapabilityReceipt,
} from '../lib/capability-attestation-receipts.js';

const receipt = (overrides = {}) => ({
  schema: 'AftergraphLenovoPlacementCapabilityAcceptance/v1',
  machine: 'JONAS-LENOVO',
  runner_name: 'JONAS-LENOVO-runtime-acceptance',
  github_run_id: '37530000000',
  github_sha: 'a'.repeat(40),
  observed_at_utc: '2026-10-06T20:00:00.000Z',
  worker_id: 'wrkr_jonas_lenovo',
  pool: 'jonas-lenovo',
  physical_host: 'PASS',
  computer_node_task_running: true,
  works_worker_task_running: true,
  interactive_session_present: true,
  explorer_running: true,
  dwm_running: true,
  healthy_monitor_count: 1,
  ...overrides,
});

test('Lenovo placement receipt mints only the fixed governed capability set', () => {
  const out = attestationsFromCapabilityReceipt(receipt(), {
    verifiedAt: '2026-10-06T20:00:05.000Z',
    freshnessTtlMs: 300_000,
  });

  assert.deepEqual(
    out.map((row) => [row.nodeId, row.capability, row.state]),
    [
      ['wrkr_jonas_lenovo', 'computer', 'AVAILABLE'],
      ['wrkr_jonas_lenovo', 'local.desktop', 'AVAILABLE'],
      ['wrkr_jonas_lenovo', 'local.device', 'AVAILABLE'],
    ],
  );
  assert.equal(new Set(out.map((row) => row.id)).size, 3);
  assert.ok(out.every((row) => row.source === 'sentinel:receipt:AftergraphLenovoPlacementCapabilityAcceptance/v1'));
});

test('attestation ids are stable per node and capability across probe runs', () => {
  const a = attestationsFromCapabilityReceipt(receipt(), {
    verifiedAt: '2026-10-06T20:00:05.000Z',
  });
  const b = attestationsFromCapabilityReceipt(
    receipt({
      github_run_id: '37530000001',
      github_sha: 'b'.repeat(40),
      observed_at_utc: '2026-10-06T20:04:00.000Z',
    }),
    { verifiedAt: '2026-10-06T20:04:05.000Z' },
  );

  assert.deepEqual(
    a.map((row) => [row.capability, row.id]),
    b.map((row) => [row.capability, row.id]),
  );
  assert.notEqual(a[0].observedAt, b[0].observedAt);
});

test('receipt cannot widen semantic capabilities', () => {
  assert.throws(
    () =>
      attestationsFromCapabilityReceipt(
        { ...receipt(), capability: 'shell' },
        { verifiedAt: '2026-10-06T20:00:05.000Z' },
      ),
    /shape is invalid/,
  );
});

test('receipt fails closed for any missing physical or worker proof', () => {
  const invalid = [
    { worker_id: 'wrkr_other' },
    { pool: 'vds' },
    { physical_host: 'FAIL' },
    { computer_node_task_running: false },
    { works_worker_task_running: false },
    { interactive_session_present: false },
    { explorer_running: false },
    { dwm_running: false },
    { healthy_monitor_count: 0 },
  ];

  for (const patch of invalid) {
    assert.throws(
      () =>
        attestationsFromCapabilityReceipt(receipt(patch), {
          verifiedAt: '2026-10-06T20:00:05.000Z',
        }),
      /did not prove required fields/,
    );
  }
});

test('unknown receipt schemas and invalid freshness fail closed', () => {
  assert.throws(
    () =>
      attestationsFromCapabilityReceipt(
        { schema: 'Unknown/v1' },
        { verifiedAt: '2026-10-06T20:00:05.000Z' },
      ),
    /unsupported capability receipt schema/,
  );

  assert.throws(
    () =>
      attestationsFromCapabilityReceipt(receipt(), {
        verifiedAt: '2026-10-06T19:59:59.000Z',
      }),
    /predates observation/,
  );

  assert.throws(
    () =>
      attestationsFromCapabilityReceipt(receipt(), {
        verifiedAt: '2026-10-06T20:00:05.000Z',
        freshnessTtlMs: 60 * 60 * 1000 + 1,
      }),
    /TTL is invalid/,
  );
});

test('ingest overwrites the stable capability records instead of accumulating stale duplicates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-cap-receipt-'));
  try {
    const storePath = join(dir, 'capabilities.json');

    const first = ingestCapabilityReceipt({
      receipt: receipt(),
      storePath,
      verifiedAt: '2026-10-06T20:00:05.000Z',
    });
    const second = ingestCapabilityReceipt({
      receipt: receipt({
        github_run_id: '37530000001',
        github_sha: 'b'.repeat(40),
        observed_at_utc: '2026-10-06T20:04:00.000Z',
      }),
      storePath,
      verifiedAt: '2026-10-06T20:04:05.000Z',
    });

    assert.deepEqual(
      first.map((row) => row.id),
      second.map((row) => row.id),
    );

    const persisted = JSON.parse(readFileSync(storePath, 'utf8'));
    assert.equal(persisted.attestations.length, 3);
    assert.ok(
      persisted.attestations.every(
        (row) => row.observedAt === '2026-10-06T20:04:00.000Z',
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
