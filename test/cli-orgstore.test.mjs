import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrgStore } from '../lib/org-store.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'bin', 'sentinel.js');
const TOKEN = 'cli-orgstore-test-token';

function scratch(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sentinel-cli-orgstore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Seeds a one-org store file; returns its path + the org row.
function seedOrgStore(dir) {
  const storePath = path.join(dir, 'orgs.json');
  const store = createOrgStore(storePath);
  const org = store.createOrg('Acme Seeded');
  const ws = store.createWorkspace(org.id, 'ws-seed');
  store.linkRepo({ orgId: org.id, workspaceId: ws.id, fullName: 'acme/seeded', installationId: 'inst-seed' });
  return { storePath, org };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

// Boots `sentinel serve` as a child on a free port; resolves once
// /api/healthz answers (or the child exits). Caller owns nothing: the
// child is killed automatically after the test.
async function bootServe(t, extraArgs) {
  const dir = scratch(t);
  const port = await freePort();
  const child = spawn(process.execPath, [
    CLI, 'serve', '--host', '127.0.0.1', '--port', String(port),
    '--token', TOKEN,
    '--ledger-path', path.join(dir, 'ledger.jsonl'),
    '--memory-path', path.join(dir, 'mem.jsonl'),
    ...extraArgs,
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  t.after(() => child.kill('SIGKILL'));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  for (;;) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${base}/api/healthz`);
      if (res.ok) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { base, child, get stderr() { return stderr; } };
}

function authed(p, init = {}) {
  return { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${TOKEN}` } };
}

test('cli org-store: --org-store passes through (GET /api/orgs returns the seeded org)', async (t) => {
  const dir = scratch(t);
  const { storePath, org } = seedOrgStore(dir);
  const srv = await bootServe(t, ['--org-store', storePath]);
  assert.equal(srv.child.exitCode, null, `server exited early: ${srv.stderr}`);
  const res = await fetch(`${srv.base}/api/orgs`, authed());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.orgs, [{ id: org.id, name: 'Acme Seeded' }]);
  const repos = await fetch(`${srv.base}/api/orgs/${org.id}/repos`, authed());
  assert.equal(repos.status, 200);
  const reposBody = await repos.json();
  assert.ok(reposBody.repos.some((r) => r.repo === 'acme/seeded'), JSON.stringify(reposBody));
});

test('cli org-store: without the flag /api/orgs 404s as today', async (t) => {
  const srv = await bootServe(t, []);
  assert.equal(srv.child.exitCode, null, `server exited early: ${srv.stderr}`);
  const res = await fetch(`${srv.base}/api/orgs`, authed());
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error, 'not found');
});

test('cli org-store: missing file fails closed at boot (non-zero exit, no socket)', async (t) => {
  const dir = scratch(t);
  const missing = path.join(dir, 'no-such-orgs.json');
  const port = await freePort();
  const r = spawnSync(process.execPath, [
    CLI, 'serve', '--host', '127.0.0.1', '--port', String(port),
    '--token', TOKEN, '--org-store', missing,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  assert.ok(r.status !== null && r.status !== 0, `expected non-zero exit, got status=${r.status}`);
  assert.match(r.stderr, /org store/i);
  let refused = false;
  try {
    await fetch(`http://127.0.0.1:${port}/api/healthz`);
  } catch {
    refused = true;
  }
  assert.equal(refused, true, 'no socket may listen after fail-closed boot');
});

test('cli org-store: --help documents the flag', (t) => {
  const r = spawnSync(process.execPath, [CLI, '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('--org-store'), r.stdout);
});
