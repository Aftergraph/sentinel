import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createConsoleServer } from '../console/server.js';
import { createOrgStore } from '../lib/org-store.js';

const CLEAN_DIFF = `diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
`;

const EVAL_DIFF = `diff --git a/srv/app.js b/srv/app.js
index 1111111..2222222 100644
--- a/srv/app.js
+++ b/srv/app.js
@@ -1,3 +1,4 @@
 export function run(input) {
+  return eval(input);
 }
`;

const UNKNOWN_ORG = 'org_ffffffffffff';
const MALFORMED_ORG = 'not-an-org!!!';

async function boot(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-org-'));
  const handler = createConsoleServer({
    ledgerPath: join(dir, 'ledger.jsonl'),
    memoryPath: join(dir, 'mem.jsonl'),
    // Hermetic: never discover cwd config (a stray file would poison results).
    configPath: join(dir, 'sentinel.config.json'),
    ...opts,
  });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    dir,
    async call(method, path, body, headers = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json() };
    },
    async close() {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// Seeds a two-org store file inside dir; returns ids + store handle (the
// server re-reads the file per scoped request, so later links are visible).
function seedTwoOrgs(dir) {
  const storePath = join(dir, 'orgs.json');
  const store = createOrgStore(storePath);
  const orgA = store.createOrg('Acme A');
  const orgB = store.createOrg('Acme B');
  const wsA = store.createWorkspace(orgA.id, 'ws-a');
  const wsB = store.createWorkspace(orgB.id, 'ws-b');
  store.linkRepo({ orgId: orgA.id, workspaceId: wsA.id, fullName: 'acme/repo-a', installationId: 'inst-a' });
  store.linkRepo({ orgId: orgB.id, workspaceId: wsB.id, fullName: 'acme/repo-b', installationId: 'inst-b' });
  return { storePath, store, orgA, orgB };
}

const repoNames = (rows) => rows.map((r) => r.repo).sort();

test('org-scope: without orgStorePath behavior is unchanged (?org ignored, org routes 404)', async () => {
  const c = await boot({ repos: ['flag/plain'] });
  try {
    const clean = await c.call('POST', '/api/review', { diff: CLEAN_DIFF, repo: 'ship/repo', pr: 1 });
    assert.equal(clean.status, 200);
    const plain = await c.call('GET', '/api/repos');
    assert.equal(plain.status, 200);
    assert.deepEqual(repoNames(plain.json.repos), ['flag/plain', 'ship/repo']);
    // Stray ?org= is ignored exactly as before (unscoped union).
    const scoped = await c.call('GET', `/api/repos?org=${UNKNOWN_ORG}`);
    assert.equal(scoped.status, 200);
    assert.deepEqual(scoped.json, plain.json);
    const ov = await c.call('GET', '/api/overview');
    const ovScoped = await c.call('GET', `/api/overview?org=${UNKNOWN_ORG}`);
    assert.equal(ovScoped.status, 200);
    assert.deepEqual(ovScoped.json, ov.json);
    assert.equal((await c.call('GET', '/api/orgs')).status, 404);
    assert.equal((await c.call('GET', `/api/orgs/${UNKNOWN_ORG}/repos`)).status, 404);
  } finally { await c.close(); }
});

test('org-scope: /api/orgs lists seeded orgs as {id, name}', async () => {
  const c = await boot();
  try {
    const seed = seedTwoOrgs(c.dir);
    const s = await boot({ orgStorePath: seed.storePath });
    try {
      const { status, json } = await s.call('GET', '/api/orgs');
      assert.equal(status, 200);
      assert.deepEqual(
        [...json.orgs].sort((a, b) => (a.id < b.id ? -1 : 1)),
        [
          { id: seed.orgA.id, name: 'Acme A' },
          { id: seed.orgB.id, name: 'Acme B' },
        ].sort((a, b) => (a.id < b.id ? -1 : 1)),
      );
      for (const o of json.orgs) assert.deepEqual(Object.keys(o).sort(), ['id', 'name']);
      // Empty store file (no orgs yet) lists an empty set, not an error.
      const emptyDir = mkdtempSync(join(tmpdir(), 'sentinel-org-empty-'));
      try {
        const emptyPath = join(emptyDir, 'orgs.json');
        createOrgStore(emptyPath);
        const e = await boot({ orgStorePath: emptyPath });
        try {
          const r = await e.call('GET', '/api/orgs');
          assert.equal(r.status, 200);
          assert.deepEqual(r.json, { orgs: [] });
        } finally { await e.close(); }
      } finally { rmSync(emptyDir, { recursive: true, force: true }); }
    } finally { await s.close(); }
  } finally { await c.close(); }
});

test('org-scope: per-org repos and ?org= filtering on /api/repos', async () => {
  const c = await boot();
  try {
    const seed = seedTwoOrgs(c.dir);
    const boot2 = await boot({ orgStorePath: seed.storePath });
    try {
      for (const [repo, pr] of [['acme/repo-a', 1], ['acme/repo-b', 2]]) {
        const r = await boot2.call('POST', '/api/review', { diff: CLEAN_DIFF, repo, pr });
        assert.equal(r.status, 200);
        assert.equal(r.json.verdict, 'SHIP');
      }
      // Linked-but-never-reviewed repo still appears as a bare row.
      seed.store.linkRepo({
        orgId: seed.orgA.id,
        workspaceId: seed.store.reposForOrg(seed.orgA.id)[0].workspaceId,
        fullName: 'acme/pending',
        installationId: 'inst-a2',
      });

      const a = await boot2.call('GET', `/api/orgs/${seed.orgA.id}/repos`);
      assert.equal(a.status, 200);
      assert.deepEqual(repoNames(a.json.repos), ['acme/pending', 'acme/repo-a']);
      const pending = a.json.repos.find((r) => r.repo === 'acme/pending');
      assert.deepEqual(pending, { repo: 'acme/pending' });
      const reviewed = a.json.repos.find((r) => r.repo === 'acme/repo-a');
      assert.equal(reviewed.lastVerdict, 'SHIP');
      assert.ok(reviewed.receiptId);

      const b = await boot2.call('GET', `/api/orgs/${seed.orgB.id}/repos`);
      assert.equal(b.status, 200);
      assert.deepEqual(repoNames(b.json.repos), ['acme/repo-b']);

      const qa = await boot2.call('GET', `/api/repos?org=${seed.orgA.id}`);
      assert.equal(qa.status, 200);
      assert.deepEqual(qa.json, a.json);
      const qb = await boot2.call('GET', `/api/repos?org=${seed.orgB.id}`);
      assert.equal(qb.status, 200);
      assert.deepEqual(qb.json, b.json);
      const all = await boot2.call('GET', '/api/repos');
      // Linked-but-never-reviewed names live only in the org store, so the
      // unscoped union (flags + ledger) cannot see acme/pending.
      assert.deepEqual(repoNames(all.json.repos), ['acme/repo-a', 'acme/repo-b']);
    } finally { await boot2.close(); }
  } finally { await c.close(); }
});

test('org-scope: cross-org invisibility in /api/overview (B receipt invisible to ?org=A)', async () => {
  const c = await boot();
  try {
    const seed = seedTwoOrgs(c.dir);
    const s = await boot({ orgStorePath: seed.storePath });
    try {
      const clean = await s.call('POST', '/api/review', { diff: CLEAN_DIFF, repo: 'acme/repo-a', pr: 1 });
      assert.equal(clean.json.verdict, 'SHIP');
      const dirty = await s.call('POST', '/api/review', { diff: EVAL_DIFF, repo: 'acme/repo-b', pr: 7 });
      assert.equal(dirty.json.verdict, 'DO_NOT_SHIP');
      const blockingCount = dirty.json.findings.blocking.length;
      assert.ok(blockingCount >= 1);

      const scopedA = await s.call('GET', `/api/overview?org=${seed.orgA.id}`);
      assert.equal(scopedA.status, 200);
      assert.equal(scopedA.json.open, 1);
      assert.equal(scopedA.json.blocked, 0);
      assert.equal(scopedA.json.stale, 0);
      assert.equal(scopedA.json.critical, 0);
      assert.equal(scopedA.json.confidence, 1);
      assert.deepEqual(scopedA.json.needsAttention, []);
      assert.equal(scopedA.json.recentVerdicts.length, 1);
      assert.equal(scopedA.json.recentVerdicts[0].repo, 'acme/repo-a');
      // The org-B receipt must not leak into org A's scope anywhere.
      assert.ok(!JSON.stringify(scopedA.json).includes('acme/repo-b'));

      const scopedB = await s.call('GET', `/api/overview?org=${seed.orgB.id}`);
      assert.equal(scopedB.status, 200);
      assert.equal(scopedB.json.open, 1);
      assert.equal(scopedB.json.blocked, 1);
      assert.equal(scopedB.json.critical, blockingCount);
      assert.equal(scopedB.json.confidence, 0);
      assert.deepEqual(scopedB.json.needsAttention.map((q) => q.repo), ['acme/repo-b']);
      assert.deepEqual(scopedB.json.recentVerdicts.map((r) => r.repo), ['acme/repo-b']);
      assert.ok(!JSON.stringify(scopedB.json).includes('acme/repo-a'));

      // Unscoped overview still sees everything.
      const full = await s.call('GET', '/api/overview');
      assert.equal(full.json.open, 2);
      assert.equal(full.json.blocked, 1);
      assert.equal(full.json.recentVerdicts.length, 2);
    } finally { await s.close(); }
  } finally { await c.close(); }
});

test('org-scope: 400 on malformed/unknown query scope, 404 (not 403) on unknown path org', async () => {
  const c = await boot();
  try {
    const seed = seedTwoOrgs(c.dir);
    const s = await boot({ orgStorePath: seed.storePath });
    try {
      // Unknown but well-formed id.
      const path404 = await s.call('GET', `/api/orgs/${UNKNOWN_ORG}/repos`);
      assert.equal(path404.status, 404);
      assert.ok(path404.json.error);
      assert.equal((await s.call('GET', `/api/repos?org=${UNKNOWN_ORG}`)).status, 400);
      assert.equal((await s.call('GET', `/api/overview?org=${UNKNOWN_ORG}`)).status, 400);
      // Malformed id.
      assert.equal((await s.call('GET', `/api/orgs/${MALFORMED_ORG}/repos`)).status, 400);
      assert.equal((await s.call('GET', `/api/repos?org=${MALFORMED_ORG}`)).status, 400);
      assert.equal((await s.call('GET', `/api/overview?org=${MALFORMED_ORG}`)).status, 400);
      // Empty ?org= is malformed.
      assert.equal((await s.call('GET', '/api/repos?org=')).status, 400);
      assert.equal((await s.call('GET', '/api/overview?org=')).status, 400);
      // Wrong sub-path under a real org is a missing route, not a scope leak.
      assert.equal((await s.call('GET', `/api/orgs/${seed.orgA.id}/members`)).status, 404);
    } finally { await s.close(); }
  } finally { await c.close(); }
});

test('org-scope: token gate guards the new routes (401 without, 200 with)', async () => {
  const c = await boot();
  try {
    const seed = seedTwoOrgs(c.dir);
    const s = await boot({ orgStorePath: seed.storePath, token: 'tok' });
    try {
      const auth = { authorization: 'Bearer tok' };
      assert.equal((await s.call('GET', '/api/healthz')).status, 200);
      assert.equal((await s.call('GET', '/api/orgs')).status, 401);
      assert.equal((await s.call('GET', `/api/orgs/${seed.orgA.id}/repos`)).status, 401);
      assert.equal((await s.call('GET', `/api/repos?org=${seed.orgA.id}`)).status, 401);
      assert.equal((await s.call('GET', `/api/overview?org=${seed.orgA.id}`)).status, 401);
      assert.equal((await s.call('GET', '/api/orgs', undefined, auth)).status, 200);
      assert.equal((await s.call('GET', `/api/orgs/${seed.orgA.id}/repos`, undefined, auth)).status, 200);
      assert.equal((await s.call('GET', `/api/repos?org=${seed.orgA.id}`, undefined, auth)).status, 200);
      assert.equal((await s.call('GET', `/api/overview?org=${seed.orgA.id}`, undefined, auth)).status, 200);
      // Gated unknown org still 404 (not 403) once authenticated.
      assert.equal((await s.call('GET', `/api/orgs/${UNKNOWN_ORG}/repos`, undefined, auth)).status, 404);
    } finally { await s.close(); }
  } finally { await c.close(); }
});
