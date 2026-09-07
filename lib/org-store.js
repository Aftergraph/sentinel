// Org/Workspace persistence — file-backed JSON tenant registry.
//
// State shape (single JSON file):
//   {
//     organizations: [{ id, name, createdAt }],
//     workspaces:    [{ id, orgId, name, createdAt }],
//     memberships:   [{ orgId, userId, role }],
//     repos:         [{ id, orgId, workspaceId, fullName, installationId, createdAt }]
//   }
//
// IDs: `org_` / `ws_` / `repo_` + 12 hex chars from node:crypto.
// Roles: owner | admin | member. The first membership of an org must be
// owner (enforced in addMember).
//
// Tenant scope is validated on every mutation (fail closed):
// - workspace org must exist (createWorkspace)
// - repo workspace must exist AND belong to the same org (linkRepo)
// - membership role changes require an existing owner/admin actor, passed
//   explicitly as actorRole (setMemberRole); `member` (or a missing actor)
//   throws.
// - repo fullName is unique per org (linkRepo).
//
// Persistence: atomic write (tmp file + rename), load on construct. A
// missing file yields an empty store; a corrupt file (unparseable JSON or
// wrong shape) throws fail-closed — never silently reset.
//
// Every mutation appends one audit event via ./audit.js:
// org.created, workspace.created, member.added, role.changed, repo.linked.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { append } from './audit.js';

const ROLES = new Set(['owner', 'admin', 'member']);
const ACTOR_ROLES = new Set(['owner', 'admin']);

const STATE_KEYS = ['organizations', 'workspaces', 'memberships', 'repos'];

function genId(prefix) {
  return `${prefix}${randomBytes(6).toString('hex')}`;
}

function now() {
  return new Date().toISOString();
}

function requireFilePath(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('createOrgStore requires filePath');
  }
  return filePath;
}

function requireName(what, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what} requires name`);
  }
  return value.trim();
}

function requireId(what, value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what} requires id`);
  }
  return value;
}

function requireUserId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('membership requires userId');
  }
  return value;
}

function requireRole(value) {
  if (typeof value !== 'string' || !ROLES.has(value)) {
    throw new Error('membership requires role owner|admin|member');
  }
  return value;
}

function emptyState() {
  return { organizations: [], workspaces: [], memberships: [], repos: [] };
}

function loadFile(filePath) {
  if (!existsSync(filePath)) return emptyState();
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`org-store: cannot read store file (${filePath}): ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`org-store: corrupt store file (${filePath}): invalid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`org-store: corrupt store file (${filePath}): expected an object`);
  }
  const state = emptyState();
  for (const key of STATE_KEYS) {
    if (parsed[key] === undefined) continue;
    if (!Array.isArray(parsed[key])) {
      throw new Error(`org-store: corrupt store file (${filePath}): "${key}" must be an array`);
    }
    for (const entry of parsed[key]) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`org-store: corrupt store file (${filePath}): "${key}" holds a non-object entry`);
      }
    }
    state[key] = parsed[key];
  }
  return state;
}

function persist(filePath, state) {
  mkdirSync(dirname(filePath), { recursive: true });
  // Uniquely-named tmp: no predictable sibling for symlink games, no partial.
  const tmp = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, filePath);
}

function copy(record) {
  return record ? { ...record } : record;
}

export function createOrgStore(filePath) {
  requireFilePath(filePath);
  let state = loadFile(filePath);
  const save = () => persist(filePath, state);

  function findOrg(orgId) {
    return state.organizations.find((o) => o.id === orgId) || null;
  }

  function requireOrg(orgId, what) {
    const id = requireId('org', orgId);
    const org = findOrg(id);
    if (!org) throw new Error(`${what} unknown org (${id})`);
    return org;
  }

  function findWorkspace(workspaceId) {
    return state.workspaces.find((w) => w.id === workspaceId) || null;
  }

  const store = {
    filePath,

    reload() {
      state = loadFile(filePath);
      return true;
    },

    createOrg(name) {
      const clean = requireName('createOrg', name);
      const org = { id: genId('org_'), name: clean, createdAt: now() };
      state.organizations.push(org);
      save();
      append('org.created', { actor: 'org-store', reason: `org:created:${org.id}:${org.name}` });
      return copy(org);
    },

    createWorkspace(orgId, name) {
      const org = requireOrg(orgId, 'createWorkspace');
      const clean = requireName('createWorkspace', name);
      const workspace = { id: genId('ws_'), orgId: org.id, name: clean, createdAt: now() };
      state.workspaces.push(workspace);
      save();
      append('workspace.created', {
        actor: 'org-store',
        reason: `workspace:created:${workspace.id}:${org.id}:${workspace.name}`,
      });
      return copy(workspace);
    },

    addMember(orgId, userId, role) {
      const org = requireOrg(orgId, 'addMember');
      const user = requireUserId(userId);
      const cleanRole = requireRole(role);
      const existing = state.memberships.filter((m) => m.orgId === org.id);
      if (existing.length === 0 && cleanRole !== 'owner') {
        throw new Error('addMember first membership of an org must be owner');
      }
      if (existing.some((m) => m.userId === user)) {
        throw new Error(`addMember duplicate membership (${org.id}:${user})`);
      }
      const membership = { orgId: org.id, userId: user, role: cleanRole };
      state.memberships.push(membership);
      save();
      append('member.added', {
        actor: 'org-store',
        reason: `member:added:${org.id}:${user}:${cleanRole}`,
      });
      return copy(membership);
    },

    // actorRole is the caller's already-authenticated role, passed
    // explicitly (string) or as { actorRole }. Only owner/admin may change
    // roles; `member` (or a missing/invalid actor) throws.
    setMemberRole(orgId, userId, role, actorRole) {
      const actor = actorRole && typeof actorRole === 'object' ? actorRole.actorRole : actorRole;
      if (typeof actor !== 'string' || !ACTOR_ROLES.has(actor)) {
        throw new Error('setMemberRole requires an owner/admin actorRole');
      }
      const org = requireOrg(orgId, 'setMemberRole');
      const user = requireUserId(userId);
      const cleanRole = requireRole(role);
      const membership = state.memberships.find((m) => m.orgId === org.id && m.userId === user);
      if (!membership) throw new Error(`setMemberRole unknown membership (${org.id}:${user})`);
      const prev = membership.role;
      membership.role = cleanRole;
      save();
      append('role.changed', {
        actor: 'org-store',
        from: prev,
        to: cleanRole,
        reason: `member:role-changed:${org.id}:${user}:${prev}->${cleanRole}:by-${actor}`,
      });
      return copy(membership);
    },

    // Accepts linkRepo({ orgId, workspaceId, fullName, installationId }) or
    // positional linkRepo(orgId, workspaceId, fullName, installationId).
    linkRepo(input, workspaceId, fullName, installationId) {
      const args = input && typeof input === 'object' && !Array.isArray(input)
        ? input
        : { orgId: input, workspaceId, fullName, installationId };
      const org = requireOrg(args.orgId, 'linkRepo');
      const wsId = requireId('workspace', args.workspaceId);
      const workspace = findWorkspace(wsId);
      if (!workspace) throw new Error(`linkRepo unknown workspace (${wsId})`);
      if (workspace.orgId !== org.id) {
        throw new Error(`linkRepo workspace ${wsId} belongs to org ${workspace.orgId}, not ${org.id}`);
      }
      if (typeof args.fullName !== 'string' || args.fullName.trim() === '') {
        throw new Error('linkRepo requires fullName');
      }
      const cleanFullName = args.fullName.trim();
      if (state.repos.some((r) => r.orgId === org.id && r.fullName === cleanFullName)) {
        throw new Error(`linkRepo duplicate repo (${org.id}:${cleanFullName})`);
      }
      if (
        args.installationId === undefined ||
        args.installationId === null ||
        (typeof args.installationId === 'string' && args.installationId.trim() === '')
      ) {
        throw new Error('linkRepo requires installationId');
      }
      const repo = {
        id: genId('repo_'),
        orgId: org.id,
        workspaceId: workspace.id,
        fullName: cleanFullName,
        installationId: args.installationId,
        createdAt: now(),
      };
      state.repos.push(repo);
      save();
      append('repo.linked', {
        actor: 'org-store',
        reason: `repo:linked:${repo.id}:${org.id}:${workspace.id}:${cleanFullName}`,
      });
      return copy(repo);
    },

    getOrg(orgId) {
      if (typeof orgId !== 'string' || orgId === '') return null;
      return copy(findOrg(orgId));
    },

    getWorkspace(workspaceId) {
      if (typeof workspaceId !== 'string' || workspaceId === '') return null;
      return copy(findWorkspace(workspaceId));
    },

    getMember(orgId, userId) {
      if (typeof orgId !== 'string' || typeof userId !== 'string') return null;
      return copy(state.memberships.find((m) => m.orgId === orgId && m.userId === userId) || null);
    },

    listOrgs() {
      return state.organizations.map(copy);
    },

    membersForOrg(orgId) {
      if (typeof orgId !== 'string' || orgId === '') return [];
      return state.memberships.filter((m) => m.orgId === orgId).map(copy);
    },

    reposForOrg(orgId) {
      if (typeof orgId !== 'string' || orgId === '') return [];
      return state.repos.filter((r) => r.orgId === orgId).map(copy);
    },

    reposForWorkspace(workspaceId) {
      if (typeof workspaceId !== 'string' || workspaceId === '') return [];
      return state.repos.filter((r) => r.workspaceId === workspaceId).map(copy);
    },

    isMember(orgId, userId) {
      if (typeof orgId !== 'string' || typeof userId !== 'string') return false;
      return state.memberships.some((m) => m.orgId === orgId && m.userId === userId);
    },
  };

  return store;
}
