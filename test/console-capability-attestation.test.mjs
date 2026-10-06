import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsoleServer } from '../console/server.js';
import { createCapabilityAttestationStore } from '../lib/capability-attestation-store.js';

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-cap-query-'));
  const storePath = join(dir, 'capabilities.json');
  const store = createCapabilityAttestationStore(storePath);
  store.put({
    id: 'att_vds_browser_1',
    nodeId: 'wrkr_vds_1',
    capability: 'browser',
    state: 'AVAILABLE',
    observedAt: '2026-10-06T18:00:00.000Z',
    verifiedAt: '2026-10-06T18:00:05.000Z',
    freshnessTtlMs: 60_000,
    source: 'sentinel:independent-probe',
  });
  const token = 'verifier-secret';
  const handler = createConsoleServer({
    token,
    capabilityAttestationStorePath: storePath,
    capabilityAttestationNow: () => Date.parse('2026-10-06T18:00:30.000Z'),
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    token,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('capability attestation query is bearer-gated and returns verifier truth', async () => {
  const c = await boot();
  try {
    const unauth = await fetch(c.base + '/v1/capability-attestations/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: 'aftergraph.capability-attestation-query/1.0',
        node_ids: ['wrkr_vds_1'],
        capabilities: ['browser'],
      }),
    });
    assert.equal(unauth.status, 401);

    const response = await fetch(c.base + '/v1/capability-attestations/query', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + c.token,
      },
      body: JSON.stringify({
        schema: 'aftergraph.capability-attestation-query/1.0',
        node_ids: ['wrkr_vds_1'],
        capabilities: ['browser'],
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.schema, 'aftergraph.capability-attestations/1.0');
    assert.equal(body.attestations.length, 1);
    assert.equal(body.attestations[0].state, 'AVAILABLE');
    assert.equal(body.attestations[0].source, 'sentinel:independent-probe');
  } finally {
    await c.close();
  }
});

test('capability attestation query fails closed when the verifier store is not configured', async () => {
  const token = 'verifier-secret';
  const handler = createConsoleServer({ token });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(base + '/v1/capability-attestations/query', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({
        schema: 'aftergraph.capability-attestation-query/1.0',
        node_ids: ['wrkr_vds_1'],
        capabilities: ['browser'],
      }),
    });
    assert.equal(response.status, 503);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
