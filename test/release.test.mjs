import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createConsoleServer } from '../console/server.js';
import { SERVER_VERSION } from '../mcp/sentinel-mcp.js';
import { RULE_PACK_VERSION } from '../lib/rulepack.js';

const ROOT = new URL('..', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const readSrc = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');

test('release: package version stays 0.x (no 1.0 claims)', () => {
  assert.match(pkg.version, /^0\.\d+\.\d+$/, 'package version must stay 0.x');
});

test('release: single source — MCP SERVER_VERSION === package.json version', () => {
  assert.equal(SERVER_VERSION, pkg.version);
});

test('release: version modules read package.json (no hardcoded fork)', () => {
  for (const rel of ['console/server.js', 'mcp/sentinel-mcp.js', 'bin/sentinel.js']) {
    const src = readSrc(rel);
    assert.ok(src.includes('package.json'), `${rel} must read the version from package.json`);
    assert.ok(
      !src.includes(`'${pkg.version}'`) && !src.includes(`"${pkg.version}"`),
      `${rel} must not hardcode the package version ${pkg.version}`,
    );
  }
});

test('release: console /api/healthz version === package.json version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-release-'));
  const handler = createConsoleServer({
    ledgerPath: join(dir, 'ledger.jsonl'),
    memoryPath: join(dir, 'mem.jsonl'),
    configPath: join(dir, 'sentinel.config.json'),
  });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/healthz`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.version, pkg.version);
    assert.equal(json.pack, RULE_PACK_VERSION);
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release: CHANGELOG top entry matches package version', () => {
  const changelog = readSrc('CHANGELOG.md');
  const m = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m);
  assert.ok(m, 'CHANGELOG must have a top-level ## [x.y.z] entry');
  assert.equal(m[1], pkg.version, 'CHANGELOG top entry must match package.json version');
  assert.match(m[1], /^0\./, 'CHANGELOG top entry must stay 0.x');
});

test('release: files list covers bin/lib/console/mcp/apps/bench entry points', () => {
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, 'package.json files must be a non-empty list');
  const covered = (p) => pkg.files.some((e) => p === e.replace(/\/$/, '') || p.startsWith(e));
  for (const entry of [
    'bin/sentinel.js',
    'lib/review.js',
    'lib/rulepack.js',
    'console/server.js',
    'console/public/app.js',
    'mcp/sentinel-mcp.js',
    'apps/github/app.js',
    'bench/runner.js',
    'bench/report.js',
    'bench/cases/',
    'policies/web-default.yaml',
  ]) {
    assert.ok(covered(entry), `files list must cover runtime entry ${entry}`);
  }
});

test('release: files list excludes ledger-ish and dev-only artifacts', () => {
  for (const e of pkg.files) {
    assert.doesNotMatch(e, /ledger/i, `files entry must not include ledger artifacts: ${e}`);
    assert.doesNotMatch(e, /\.env/i, `files entry must not include env files: ${e}`);
    assert.doesNotMatch(e, /node_modules/, `files entry must not include node_modules: ${e}`);
  }
  const covered = (p) => pkg.files.some((e) => p === e.replace(/\/$/, '') || p.startsWith(e));
  for (const dev of ['test/rules.test.mjs', 'prototype/precision-audit.md', 'landing/draft.md', 'tick.txt']) {
    assert.ok(!covered(dev), `files list must not ship dev-only path ${dev}`);
  }
});
