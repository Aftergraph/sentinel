// Single-writer election tests.
//
// On 2026-10-02 two Sentinel instances (vds:8788 and vps:8787) were both
// polling Aftergraph/sentinel through the same GitHub App, writing to GitHub at
// the same time. Neither could see the other's local poll state, so every fix
// had to be about making the second writer stand down.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOwnerSpec, resolveOwnership, instanceIdOf } from '../apps/github/ownership.js';
import { pollGitHubInstallationOnce } from '../apps/github/poller.js';

const OWNER_SPEC = 'Aftergraph/sentinel:sentinel-owner.json@main';

function platformWithOwnerFile(content, { throws = false } = {}) {
  const calls = [];
  return {
    calls,
    async getFileContent(repo, path, ref) {
      calls.push({ repo, path, ref });
      if (throws) throw new Error('404 Not Found');
      return content;
    },
    async listInstallationRepositories() { calls.push({ listed: true }); return []; },
    async listOpenPRs() { return []; },
  };
}

test('parseOwnerSpec splits repo, path and ref', () => {
  assert.deepEqual(parseOwnerSpec(OWNER_SPEC), {
    repo: 'Aftergraph/sentinel', path: 'sentinel-owner.json', ref: 'main',
  });
  assert.equal(parseOwnerSpec('a/b').ref, 'main');
  assert.equal(parseOwnerSpec('a/b').path, 'sentinel-owner.json');
  assert.equal(parseOwnerSpec(''), null);
  assert.equal(parseOwnerSpec('not-a-repo-spec'), null);
  assert.equal(parseOwnerSpec('a/b/c:d'), null, 'repo must be exactly owner/name');
});

test('no owner file configured means the pre-election behaviour is unchanged', async () => {
  const r = await resolveOwnership({ platform: platformWithOwnerFile('{}'), ownerSpec: undefined });
  assert.equal(r.enabled, false);
  assert.equal(r.isOwner, true, 'a single-instance deployment must keep polling');
});

test('the named instance is the owner', async () => {
  const r = await resolveOwnership({
    platform: platformWithOwnerFile(JSON.stringify({ owner: 'vds' })),
    ownerSpec: OWNER_SPEC,
    instanceId: 'vds',
  });
  assert.equal(r.isOwner, true);
  assert.equal(r.owner, 'vds');
  assert.equal(r.instanceId, 'vds');
});

test('a different named instance stands down', async () => {
  const r = await resolveOwnership({
    platform: platformWithOwnerFile(JSON.stringify({ owner: 'vds' })),
    ownerSpec: OWNER_SPEC,
    instanceId: 'vps',
  });
  assert.equal(r.isOwner, false);
  assert.equal(r.owner, 'vds');
  assert.match(r.reason, /another instance owns the review loop \(vds\)/);
});

test('an unreadable owner file stands down — fail closed, never assume ownership', async () => {
  const r = await resolveOwnership({
    platform: platformWithOwnerFile('', { throws: true }),
    ownerSpec: OWNER_SPEC,
    instanceId: 'vds',
  });
  assert.equal(r.enabled, true);
  assert.equal(r.isOwner, false, 'a reviewer that cannot prove it is the writer must not act');
  assert.match(r.reason, /fail closed/);
});

test('an unparseable or ownerless owner file stands down', async () => {
  const bad = await resolveOwnership({
    platform: platformWithOwnerFile('{ not json'), ownerSpec: OWNER_SPEC, instanceId: 'vds',
  });
  assert.equal(bad.isOwner, false);
  assert.match(bad.reason, /not valid JSON/);

  const empty = await resolveOwnership({
    platform: platformWithOwnerFile(JSON.stringify({})), ownerSpec: OWNER_SPEC, instanceId: 'vds',
  });
  assert.equal(empty.isOwner, false);
  assert.match(empty.reason, /no "owner" field/);
});

test('a platform that cannot read files stands down rather than defaulting to owner', async () => {
  const r = await resolveOwnership({ platform: {}, ownerSpec: OWNER_SPEC, instanceId: 'vds' });
  assert.equal(r.isOwner, false);
  assert.match(r.reason, /fail closed/);
});

test('instanceIdOf prefers an explicit id and falls back to the hostname', () => {
  assert.equal(instanceIdOf('  vds  '), 'vds');
  assert.equal(typeof instanceIdOf(undefined), 'string');
  assert.notEqual(instanceIdOf(''), '');
});

// The behaviour that actually matters: a standby instance must not touch state
// or post anything.
test('a standby poller returns before listing repos or writing poll state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-owner-'));
  try {
    const statePath = join(dir, 'github-poll-state.json');
    let routed = 0;
    const platform = platformWithOwnerFile(JSON.stringify({ owner: 'vds' }));

    const result = await pollGitHubInstallationOnce({
      platform,
      opts: { ownerFile: OWNER_SPEC, instanceId: 'vps', pollStatePath: statePath, pollRepos: ['Aftergraph/sentinel'] },
      routePullRequest: async () => { routed += 1; },
    });

    assert.equal(result.stoodDown, true);
    assert.equal(routed, 0, 'a standby must not route any pull request');
    assert.equal(existsSync(statePath), false, 'a standby must not write poll state');
    assert.ok(!platform.calls.some((c) => c.listed), 'a standby must not even list repositories');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the owner poller proceeds and writes its state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-owner-ok-'));
  try {
    const statePath = join(dir, 'github-poll-state.json');
    const platform = platformWithOwnerFile(JSON.stringify({ owner: 'vds' }));
    const result = await pollGitHubInstallationOnce({
      platform,
      opts: { ownerFile: OWNER_SPEC, instanceId: 'vds', pollStatePath: statePath },
      routePullRequest: async () => {},
    });
    assert.equal(result.stoodDown, undefined);
    assert.equal(result.repositories, 0);
    assert.equal(existsSync(statePath), true, 'the owner records its poll state');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an election is re-read every cycle, so ownership can move', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-owner-move-'));
  try {
    const statePath = join(dir, 'github-poll-state.json');
    let owner = 'vds';
    const platform = platformWithOwnerFile(JSON.stringify({ owner }));
    const opts = { ownerFile: OWNER_SPEC, instanceId: 'vps', pollStatePath: statePath };
    const run = () => pollGitHubInstallationOnce({ platform, opts, routePullRequest: async () => {} });

    assert.equal((await run()).stoodDown, true, 'vps stands down while vds owns');
    owner = 'vps';
    platform.getFileContent = async () => JSON.stringify({ owner });
    const after = await run();
    assert.equal(after.stoodDown, undefined, 'vps takes over once the file names it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
