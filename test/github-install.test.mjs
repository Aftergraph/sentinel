import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clear, list } from '../lib/audit.js';
import { routeEvent } from '../apps/github/app.js';
import {
  loadStore,
  handleInstallation,
  getInstallation,
  listInstallations,
} from '../apps/github/store.js';

function installPayload(overrides = {}) {
  return {
    action: 'created',
    installation: { id: 123, account: { login: 'octo' } },
    repositories: [{ full_name: 'octo/hello' }, { full_name: 'octo/world' }],
    ...overrides,
  };
}

function tmpStore(dir) {
  return { storePath: join(dir, 'installations.json') };
}

test('github install: happy path persists a tenant-scoped record + audit event', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghinst-'));
  clear();
  try {
    const noop = {};
    const out = await routeEvent({
      event: 'installation',
      payload: installPayload(),
      platform: noop,
      opts: tmpStore(dir),
    });
    assert.equal(out.handled, true);
    assert.equal(out.action, 'installation:created');
    assert.equal(out.installationId, 123);

    // File-backed: JSON on disk with the tenant-scoped record shape.
    const file = join(dir, 'installations.json');
    assert.equal(existsSync(file), true);
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const rec = raw['123'];
    assert.equal(rec.installationId, 123);
    assert.equal(rec.accountLogin, 'octo');
    assert.deepEqual(rec.repos, ['octo/hello', 'octo/world']);
    assert.equal(typeof rec.installedAt, 'string');

    // Load/save helpers see the same record.
    assert.deepEqual(getInstallation(123, file), rec);
    assert.equal(listInstallations(file).length, 1);
    assert.deepEqual(loadStore(file), raw);

    // One integration.changed audit event per install.
    const events = list().filter((e) => e.type === 'integration.changed');
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, 'github-app');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github install: redelivery is idempotent (one record, no dupe repos, event each time)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghinst-'));
  clear();
  try {
    const file = join(dir, 'installations.json');
    const first = handleInstallation(installPayload(), { storePath: file });
    // Second delivery carries a repeated repo plus a new one.
    const second = handleInstallation(
      installPayload({ repositories: [{ full_name: 'octo/world' }, { full_name: 'octo/new' }] }),
      { storePath: file },
    );
    const store = loadStore(file);
    assert.equal(Object.keys(store).length, 1);
    assert.deepEqual(second.repos, ['octo/hello', 'octo/world', 'octo/new']);
    assert.equal(second.installedAt, first.installedAt);
    const events = list().filter((e) => e.type === 'integration.changed');
    assert.equal(events.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github install: malformed payloads reject fail-closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghinst-'));
  clear();
  try {
    const file = join(dir, 'installations.json');
    assert.throws(() => handleInstallation(undefined, { storePath: file }), /requires a payload/);
    assert.throws(() => handleInstallation({}, { storePath: file }), /payload\.installation/);
    assert.throws(
      () => handleInstallation({ installation: { account: { login: 'x' } } }, { storePath: file }),
      /installation\.id/,
    );
    assert.throws(
      () => handleInstallation({ installation: { id: 1 } }, { storePath: file }),
      /account\.login/,
    );
    assert.throws(
      () => handleInstallation(installPayload({ repositories: 'nope' }), { storePath: file }),
      /repositories/,
    );
    // Malformed install via the webhook router rejects too (handler maps to 500).
    await assert.rejects(
      routeEvent({ event: 'installation', payload: {}, platform: {}, opts: { storePath: file } }),
      /payload\.installation/,
    );
    assert.deepEqual(loadStore(file), {});
    assert.equal(list().filter((e) => e.type === 'integration.changed').length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github install: unknown webhook events are ignored with a 200-style result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghinst-'));
  clear();
  try {
    let touched = false;
    const platform = new Proxy({}, { get: () => () => { touched = true; } });
    for (const event of ['repository', 'star', 'unknown-repo']) {
      const out = await routeEvent({
        event,
        payload: { action: 'created' },
        platform,
        opts: tmpStore(dir),
      });
      assert.equal(out.handled, false);
      assert.ok(out.action.startsWith('ignored:'));
    }
    assert.equal(touched, false);
    assert.equal(list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('github install: deleted action drops the record but still audits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghinst-'));
  clear();
  try {
    const file = join(dir, 'installations.json');
    handleInstallation(installPayload(), { storePath: file });
    const out = handleInstallation(installPayload({ action: 'deleted' }), { storePath: file });
    assert.equal(out, null);
    assert.equal(getInstallation(123, file), null);
    assert.equal(list().filter((e) => e.type === 'integration.changed').length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
