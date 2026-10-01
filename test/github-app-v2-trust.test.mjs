import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GITHUB_APP_CONTRACT, assertGitHubAppContract } from '../apps/github/contract.js';
import { createCredentialIssuer } from '../apps/github/credentials.js';
import { createPlatform } from '../apps/github/platform.js';
import { createDeliveryStore } from '../apps/github/delivery-store.js';
import { handleInstallation, getInstallation, ingestPR, loadPrStore } from '../apps/github/store.js';
import { loadChecks, postCheck } from '../apps/github/checks.js';

test('GitHub App contract is least-privilege and rejects permission/event drift', () => {
  assert.deepEqual(GITHUB_APP_CONTRACT.permissions, {
    contents: 'read',
    pull_requests: 'read',
    issues: 'write',
    actions: 'read',
    checks: 'write',
  });
  assert.deepEqual(GITHUB_APP_CONTRACT.events, [
    'installation',
    'installation_repositories',
    'pull_request',
    'workflow_run',
  ]);

  assert.doesNotThrow(() => assertGitHubAppContract(GITHUB_APP_CONTRACT));
  assert.throws(
    () => assertGitHubAppContract({
      ...GITHUB_APP_CONTRACT,
      permissions: { ...GITHUB_APP_CONTRACT.permissions, administration: 'write' },
    }),
    /permission drift/i,
  );
  assert.throws(
    () => assertGitHubAppContract({
      ...GITHUB_APP_CONTRACT,
      events: [...GITHUB_APP_CONTRACT.events, 'push'],
    }),
    /event drift/i,
  );
});

test('credential issuer narrows installation token to repository and permissions without persisting token', async () => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (url.endsWith('/app/installations/42/access_tokens')) {
      return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({
          token: 'ghs_super_secret',
          expires_at: '2026-10-02T02:00:00Z',
        }),
      };
    }
    throw new Error('unexpected URL ' + url);
  };

  // Key content only needs to be consumed by the injected JWT signer seam.
  const issuer = createCredentialIssuer({
    appId: '123',
    privateKeyPem: 'test-key',
    fetchImpl,
    jwtFactory: () => 'app-jwt',
  });

  const issued = await issuer.issue({
    installationId: 42,
    repositories: ['sentinel'],
    permissions: GITHUB_APP_CONTRACT.permissions,
  });

  assert.equal(issued.token, 'ghs_super_secret');
  assert.equal(issued.expiresAt, '2026-10-02T02:00:00Z');
  assert.match(issued.fingerprint, /^ghinst_[a-f0-9]{16}$/);

  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body.repositories, ['sentinel']);
  assert.deepEqual(body.permissions, GITHUB_APP_CONTRACT.permissions);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer app-jwt');

  const serialized = JSON.stringify({ fingerprint: issued.fingerprint, expiresAt: issued.expiresAt });
  assert.doesNotMatch(serialized, /ghs_super_secret/);
});

test('delivery store is restart-safe and returns immutable provenance for duplicate delivery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-delivery-'));
  const path = join(dir, 'deliveries.json');

  const input = {
    deliveryId: 'delivery-1',
    event: 'pull_request',
    action: 'opened',
    installationId: 42,
    repository: 'Aftergraph/sentinel',
    headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  };

  const first = createDeliveryStore({ path }).claim(input);
  assert.equal(first.duplicate, false);
  assert.equal(first.provenance.deliveryId, 'delivery-1');
  assert.equal(first.provenance.installationId, 42);
  assert.equal(first.provenance.repository, 'Aftergraph/sentinel');
  assert.equal(first.provenance.headSha, input.headSha);
  assert.match(first.provenance.traceId, /^[a-f0-9]{32}$/);
  assert.match(first.provenance.spanId, /^[a-f0-9]{16}$/);
  assert.equal(first.provenance.traceparent, `00-${first.provenance.traceId}-${first.provenance.spanId}-01`);

  const second = createDeliveryStore({ path }).claim(input);
  assert.equal(second.duplicate, true);
  assert.deepEqual(second.provenance, first.provenance);

  // Re-open from disk to prove restart safety.
  const third = createDeliveryStore({ path }).claim(input);
  assert.equal(third.duplicate, true);
  assert.deepEqual(third.provenance, first.provenance);

  const persisted = readFileSync(path, 'utf8');
  assert.doesNotMatch(persisted, /token|private.?key|secret/i);
});

test('delivery store rejects unsupported events/actions and conflicting replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-delivery-'));
  const path = join(dir, 'deliveries.json');
  const store = createDeliveryStore({ path });

  assert.throws(
    () => store.claim({
      deliveryId: 'd-push', event: 'push', action: 'created',
      installationId: 42, repository: 'Aftergraph/sentinel',
    }),
    /event.*not allowed/i,
  );

  assert.throws(
    () => store.claim({
      deliveryId: 'd-pr', event: 'pull_request', action: 'closed',
      installationId: 42, repository: 'Aftergraph/sentinel',
    }),
    /action.*not allowed/i,
  );

  store.claim({
    deliveryId: 'same', event: 'pull_request', action: 'opened',
    installationId: 42, repository: 'Aftergraph/sentinel',
    headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  assert.throws(
    () => store.claim({
      deliveryId: 'same', event: 'pull_request', action: 'opened',
      installationId: 43, repository: 'Aftergraph/sentinel',
      headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }),
    /conflicting replay/i,
  );
});


test('durable PR/check stores fail closed on corruption', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-state-corrupt-'));
  const prPath = join(dir, 'prs.json');
  const checksPath = join(dir, 'checks.json');
  writeFileSync(prPath, '{not-json');
  writeFileSync(checksPath, '[]');

  assert.throws(() => loadPrStore(prPath), /corrupt/i);
  assert.throws(() => loadChecks(checksPath), /corrupt/i);
});

test('installation repository removal revokes repository scope immediately', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-install-remove-'));
  const storePath = join(dir, 'installations.json');

  handleInstallation({
    action: 'created',
    installation: { id: 42, account: { login: 'Aftergraph' } },
    repositories: [{ full_name: 'Aftergraph/sentinel' }],
  }, { storePath });
  assert.deepEqual(getInstallation(42, storePath).repos, ['Aftergraph/sentinel']);

  handleInstallation({
    action: 'removed',
    installation: { id: 42, account: { login: 'Aftergraph' } },
    repositories_removed: [{ full_name: 'Aftergraph/sentinel' }],
  }, { storePath });

  assert.deepEqual(getInstallation(42, storePath).repos, []);

  const ignored = ingestPR({
    repo: 'Aftergraph/sentinel',
    prNumber: 7,
    headSha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
  }, { storePath });
  assert.deepEqual(ignored, { ignored: true });

  let apiCalls = 0;
  const api = {
    createCheckRun: async () => { apiCalls += 1; return { id: 1 }; },
    updateCheckRun: async () => { apiCalls += 1; },
  };
  const out = await postCheck({
    api,
    repo: 'Aftergraph/sentinel',
    prNumber: 7,
    headSha: 'a'.repeat(40),
    verdict: 'SHIP',
    findings: [],
  }, { storePath, checksPath: join(dir, 'checks.json') });
  assert.deepEqual(out, { ignored: true });
  assert.equal(apiCalls, 0);
});


test('GitHub platform surface exposes no authority-expanding methods', () => {
  const platform = createPlatform({
    token: 'test-token',
    fetchImpl: async () => { throw new Error('network not expected'); },
  });
  for (const forbidden of [
    'mergePullRequest',
    'enableAutoMerge',
    'approvePullRequest',
    'dismissReview',
    'updateRef',
    'createCommit',
    'updateRuleset',
    'updateBranchProtection',
    'createRepositorySecret',
    'deploy',
    'release',
  ]) {
    assert.equal(platform[forbidden], undefined, forbidden);
  }
});
