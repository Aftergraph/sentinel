import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clear, list } from '../lib/audit.js';
import { createOrgStore } from '../lib/org-store.js';

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-org-'));
  return { dir, file: join(dir, 'orgs.json') };
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

function auditTypes() {
  return list().map((e) => e.type);
}

test('org-store: full hierarchy happy path persists + emits audit', withTmp(async (_t, file) => {
  const store = createOrgStore(file);

  const org = store.createOrg('Acme');
  assert.match(org.id, /^org_[0-9a-f]{12}$/);
  assert.equal(org.name, 'Acme');
  assert.equal(typeof org.createdAt, 'string');

  const ws = store.createWorkspace(org.id, 'Eng');
  assert.match(ws.id, /^ws_[0-9a-f]{12}$/);
  assert.equal(ws.orgId, org.id);

  const owner = store.addMember(org.id, 'u-ada', 'owner');
  assert.deepEqual(owner, { orgId: org.id, userId: 'u-ada', role: 'owner' });

  const repo = store.linkRepo({ orgId: org.id, workspaceId: ws.id, fullName: 'acme/api', installationId: 123 });
  assert.match(repo.id, /^repo_[0-9a-f]{12}$/);
  assert.equal(repo.fullName, 'acme/api');

  // Lookups.
  assert.deepEqual(store.getOrg(org.id), org);
  assert.deepEqual(store.getWorkspace(ws.id), ws);
  assert.deepEqual(store.membersForOrg(org.id), [owner]);
  assert.equal(store.isMember(org.id, 'u-ada'), true);
  assert.equal(store.isMember(org.id, 'u-nobody'), false);
  assert.deepEqual(store.reposForOrg(org.id), [repo]);
  assert.deepEqual(store.reposForWorkspace(ws.id), [repo]);
  assert.equal(store.getOrg('org_missing'), null);

  // File-backed: valid JSON object with the four collections.
  assert.equal(existsSync(file), true);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.organizations.length, 1);
  assert.equal(raw.workspaces.length, 1);
  assert.equal(raw.memberships.length, 1);
  assert.equal(raw.repos.length, 1);

  // Atomic write leaves no tmp file behind.
  assert.deepEqual(readdirSync(join(file, '..')).filter((f) => f.endsWith('.tmp')), []);

  // One audit event per mutation, in order.
  assert.deepEqual(auditTypes(), [
    'org.created',
    'workspace.created',
    'member.added',
    'repo.linked',
  ]);
}));

test('org-store: cross-org repo link throws', withTmp(async (_t, file) => {
  const store = createOrgStore(file);
  const orgA = store.createOrg('A');
  const orgB = store.createOrg('B');
  const wsA = store.createWorkspace(orgA.id, 'Eng');
  const wsB = store.createWorkspace(orgB.id, 'Eng');
  store.addMember(orgA.id, 'u-a', 'owner');
  store.addMember(orgB.id, 'u-b', 'owner');
  clear();

  assert.throws(
    () => store.linkRepo({ orgId: orgA.id, workspaceId: wsB.id, fullName: 'a/api', installationId: 1 }),
    /belongs to org/,
  );
  assert.throws(
    () => store.linkRepo({ orgId: orgB.id, workspaceId: wsA.id, fullName: 'b/api', installationId: 1 }),
    /belongs to org/,
  );
  assert.throws(
    () => store.linkRepo({ orgId: orgA.id, workspaceId: 'ws_missing', fullName: 'a/api', installationId: 1 }),
    /unknown workspace/,
  );
  assert.throws(
    () => store.linkRepo({ orgId: 'org_missing', workspaceId: wsA.id, fullName: 'a/api', installationId: 1 }),
    /unknown org/,
  );
  assert.throws(
    () => store.createWorkspace('org_missing', 'Eng'),
    /unknown org/,
  );
  // Failed mutations persist nothing and emit no audit.
  assert.deepEqual(store.reposForOrg(orgA.id), []);
  assert.deepEqual(auditTypes(), []);
}));

test('org-store: member cannot change roles; owner/admin can', withTmp(async (_t, file) => {
  const store = createOrgStore(file);
  const org = store.createOrg('Acme');
  store.createWorkspace(org.id, 'Eng');
  store.addMember(org.id, 'u-owner', 'owner');
  store.addMember(org.id, 'u-member', 'member');
  clear();

  assert.throws(
    () => store.setMemberRole(org.id, 'u-member', 'admin', 'member'),
    /owner\/admin actorRole/,
  );
  assert.throws(() => store.setMemberRole(org.id, 'u-member', 'admin'), /owner\/admin actorRole/);
  assert.throws(
    () => store.setMemberRole(org.id, 'u-member', 'admin', 'superuser'),
    /owner\/admin actorRole/,
  );
  // Role unchanged after rejected attempts.
  assert.equal(store.getMember(org.id, 'u-member').role, 'member');

  const promoted = store.setMemberRole(org.id, 'u-member', 'admin', 'owner');
  assert.equal(promoted.role, 'admin');
  const demoted = store.setMemberRole(org.id, 'u-member', 'member', { actorRole: 'admin' });
  assert.equal(demoted.role, 'member');

  assert.throws(
    () => store.setMemberRole(org.id, 'u-ghost', 'admin', 'owner'),
    /unknown membership/,
  );
  assert.throws(
    () => store.setMemberRole(org.id, 'u-member', 'superadmin', 'owner'),
    /role owner\|admin\|member/,
  );

  const changed = list().filter((e) => e.type === 'role.changed');
  assert.equal(changed.length, 2);
  assert.equal(changed[0].from, 'member');
  assert.equal(changed[0].to, 'admin');
}));

test('org-store: first membership of an org must be owner', withTmp(async (_t, file) => {
  const store = createOrgStore(file);
  const org = store.createOrg('Acme');
  clear();

  assert.throws(() => store.addMember(org.id, 'u-ada', 'member'), /first membership.*must be owner/);
  assert.throws(() => store.addMember(org.id, 'u-ada', 'admin'), /first membership.*must be owner/);
  assert.deepEqual(store.membersForOrg(org.id), []);

  const owner = store.addMember(org.id, 'u-ada', 'owner');
  assert.equal(owner.role, 'owner');
  // Later memberships may be any role; duplicates throw.
  assert.equal(store.addMember(org.id, 'u-bo', 'member').role, 'member');
  assert.throws(() => store.addMember(org.id, 'u-bo', 'admin'), /duplicate membership/);
  assert.throws(() => store.addMember(org.id, 'u-bo2', 'nope'), /role owner\|admin\|member/);
  assert.deepEqual(auditTypes(), ['member.added', 'member.added']);
}));

test('org-store: repo fullName unique per org', withTmp(async (_t, file) => {
  const store = createOrgStore(file);
  const orgA = store.createOrg('A');
  const orgB = store.createOrg('B');
  const wsA1 = store.createWorkspace(orgA.id, 'Eng');
  const wsA2 = store.createWorkspace(orgA.id, 'Mobile');
  const wsB = store.createWorkspace(orgB.id, 'Eng');
  store.addMember(orgA.id, 'u-a', 'owner');
  store.addMember(orgB.id, 'u-b', 'owner');

  store.linkRepo({ orgId: orgA.id, workspaceId: wsA1.id, fullName: 'acme/api', installationId: 1 });
  // Same name, same org, different workspace still throws (unique per org).
  assert.throws(
    () => store.linkRepo({ orgId: orgA.id, workspaceId: wsA2.id, fullName: 'acme/api', installationId: 2 }),
    /duplicate repo/,
  );
  // Same name + same workspace throws too.
  assert.throws(
    () => store.linkRepo({ orgId: orgA.id, workspaceId: wsA1.id, fullName: 'acme/api', installationId: 1 }),
    /duplicate repo/,
  );
  // Same fullName in a different org is fine.
  const other = store.linkRepo({ orgId: orgB.id, workspaceId: wsB.id, fullName: 'acme/api', installationId: 9 });
  assert.equal(other.orgId, orgB.id);
  assert.equal(store.reposForOrg(orgA.id).length, 1);
}));

test('org-store: corrupt file throws fail-closed, never resets', withTmp(async (_t, file) => {
  writeFileSync(file, '{not json');
  assert.throws(() => createOrgStore(file), /corrupt store file/);
  // File left untouched (not reset to empty).
  assert.equal(readFileSync(file, 'utf8'), '{not json');

  writeFileSync(file, '["not", "an object"]');
  assert.throws(() => createOrgStore(file), /corrupt store file/);

  writeFileSync(file, JSON.stringify({ organizations: {}, workspaces: [], memberships: [], repos: [] }));
  assert.throws(() => createOrgStore(file), /corrupt store file/);

  writeFileSync(file, JSON.stringify({ organizations: [null], workspaces: [], memberships: [], repos: [] }));
  assert.throws(() => createOrgStore(file), /corrupt store file/);
}));

test('org-store: reload-from-disk round-trips', withTmp(async (_t, file) => {
  const store = createOrgStore(file);
  const org = store.createOrg('Acme');
  const ws = store.createWorkspace(org.id, 'Eng');
  const membership = store.addMember(org.id, 'u-ada', 'owner');
  const repo = store.linkRepo({ orgId: org.id, workspaceId: ws.id, fullName: 'acme/api', installationId: 123 });

  const again = createOrgStore(file);
  assert.deepEqual(again.getOrg(org.id), org);
  assert.deepEqual(again.getWorkspace(ws.id), ws);
  assert.deepEqual(again.getMember(org.id, 'u-ada'), membership);
  assert.deepEqual(again.membersForOrg(org.id), [membership]);
  assert.deepEqual(again.reposForOrg(org.id), [repo]);
  assert.deepEqual(again.reposForWorkspace(ws.id), [repo]);
  assert.equal(again.isMember(org.id, 'u-ada'), true);
  assert.deepEqual(again.listOrgs(), [org]);

  // reload() picks up writes made through another handle.
  const third = createOrgStore(file);
  third.createOrg('Other');
  assert.equal(store.listOrgs().length, 1);
  store.reload();
  assert.equal(store.listOrgs().length, 2);
}));

test('org-store: audit emitted for every mutation type', withTmp(async (_t, file) => {
  const store = createOrgStore(file);
  const org = store.createOrg('Acme');
  const ws = store.createWorkspace(org.id, 'Eng');
  store.addMember(org.id, 'u-ada', 'owner');
  store.addMember(org.id, 'u-bo', 'member');
  store.setMemberRole(org.id, 'u-bo', 'admin', 'owner');
  store.linkRepo({ orgId: org.id, workspaceId: ws.id, fullName: 'acme/api', installationId: 1 });

  const counts = {};
  for (const type of auditTypes()) counts[type] = (counts[type] ?? 0) + 1;
  assert.deepEqual(counts, {
    'org.created': 1,
    'workspace.created': 1,
    'member.added': 2,
    'role.changed': 1,
    'repo.linked': 1,
  });
}));
