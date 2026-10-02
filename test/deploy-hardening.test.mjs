// Deploy-path hardening tests.
//
// Before this file, no test in this repository referenced install.sh, the
// systemd unit, the bind address, or the deploy wrapper — the whole surface
// where the 2026-10-02 audit found its most serious findings had zero
// coverage. These assertions are deliberately static: they read the shipped
// artefacts the way a reviewer would, so a regression fails the build rather
// than waiting to be discovered on a live host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPrStore, savePrStore } from '../apps/github/store.js';
import { loadChecks, saveChecks, pruneChecks, MAX_CHECK_ENTRIES } from '../apps/github/checks.js';
import { appendLedger, loadLedger, loadLedgerPaths, rotateLedgerIfNeeded, MAX_LEDGER_GENERATIONS } from '../lib/receipt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const installSh = read('ops/deploy/install.sh');
const unit = read('ops/deploy/sentinel-github-app.service');
const appJs = read('apps/github/app.js');
const envExample = read('ops/deploy/github-app.env.example');
const wrapper = read('ops/deploy/sentinel-deploy');

// Shell/unit prose legitimately NAMES the thing it is guarding against
// ("no wildcards, no shell-quoted argument matching, which is what made the
// hand-written sudoers invalid"). Assertions about behaviour must run against
// the code, never against the comment that explains it.
const codeOf = (src) => src
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');
const installCode = codeOf(installSh);
const wrapperCode = codeOf(wrapper);

// --- the listener must not be able to bind the world by accident -------------
test('the github app binds loopback, never a bare listen(port)', () => {
  assert.match(
    appJs,
    /listen\(port,\s*host/,
    'app.js must pass an explicit host to listen()',
  );
  assert.doesNotMatch(
    appJs,
    /\.listen\(port,\s*\(\)/,
    'a bare listen(port) binds 0.0.0.0/:: and cannot be a default',
  );
  assert.match(
    appJs,
    /SENTINEL_BIND_HOST\s*\|\|\s*'127\.0\.0\.1'/,
    'the default bind address must be loopback',
  );
  assert.match(envExample, /SENTINEL_BIND_HOST/, 'the bind override must be documented');
});

// --- install.sh must not read a user-writable tree as root -------------------
test('install.sh refuses to run from a checkout it does not own', () => {
  assert.match(
    installSh,
    /require_trusted_source/,
    'install.sh must gate on source ownership before copying as root',
  );
  assert.match(
    installSh,
    /refusing to install from a checkout owned by/,
    'the ownership refusal must be explicit and greppable',
  );
  // The guard must run before the copy loop, not after it.
  const guardAt = installSh.indexOf('require_trusted_source\n');
  const copyAt = installSh.indexOf('cp -a "${REPO_SRC}');
  assert.ok(guardAt > 0 && copyAt > 0, 'both the guard and the copy must exist');
  assert.ok(guardAt < copyAt, 'the ownership guard must run before anything is copied');
});

// --- installed code must not be writable by the service account --------------
test('install.sh leaves /opt/sentinel root-owned and read-only', () => {
  assert.doesNotMatch(
    installCode,
    /chown -R sentinel:sentinel "\$\{TARGET\}"/,
    'chowning the whole tree to the service account lets it rewrite its own code',
  );
  assert.match(installCode, /chown -R root:root "\$\{TARGET\}"/);
});

// --- the unit must keep the hardening it already had, and gain the rest ------
test('the systemd unit keeps its existing hardening directives', () => {
  for (const directive of [
    'User=sentinel',
    'NoNewPrivileges=yes',
    'PrivateTmp=yes',
    'PrivateDevices=yes',
    'ProtectSystem=strict',
    'ProtectHome=yes',
    'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes',
    'ProtectControlGroups=yes',
    'RestrictSUIDSGID=yes',
    'LockPersonality=yes',
    'ReadWritePaths=/var/lib/sentinel',
  ]) {
    assert.ok(unit.includes(directive), `unit must keep ${directive}`);
  }
});

test('the systemd unit now bounds capabilities, syscalls, umask and memory', () => {
  assert.match(unit, /^CapabilityBoundingSet=\s*$/m, 'capability bounding set must be deny-all');
  assert.match(unit, /^AmbientCapabilities=\s*$/m);
  assert.match(unit, /^SystemCallFilter=@system-service$/m);
  assert.match(unit, /^UMask=0077$/m, 'default 0022 leaves state world-readable');
  assert.match(unit, /^MemoryMax=\d+[MG]$/m);
  assert.match(unit, /^TasksMax=\d+$/m);
  assert.match(unit, /^ProtectProc=invisible$/m);
});

test('MemoryDenyWriteExecute stays absent — the V8 JIT needs it off', () => {
  // Documented negative result: with the flag set, node traps in
  // SetPermissionsOnExecutableMemoryChunk before the fail-closed credential
  // check ever runs. Re-adding it would trade a clean refusal for a core dump.
  assert.doesNotMatch(unit, /^MemoryDenyWriteExecute=/m);
  assert.match(unit, /MemoryDenyWriteExecute is deliberately absent/);
});

// --- the deploy wrapper must stay free of wildcard sudo ---------------------
test('the deploy wrapper grants no wildcard command matching', () => {
  // Comments name sudoers freely; executable lines must not carry policy.
  assert.doesNotMatch(
    wrapperCode,
    /Cmnd_Alias|NOPASSWD|ALL\s*=|visudo/,
    'the wrapper must not carry sudoers policy; that lives in install-deploy-sudo.sh',
  );
  // Every verb must be an explicit case arm, not a pass-through of "$@".
  assert.match(wrapperCode, /^case "\$\{verb\}" in$/m);
  assert.doesNotMatch(wrapperCode, /exec\s+"?\$\{@\}/, 'the wrapper must not exec arbitrary argv as root');
  // An unknown verb must die rather than fall through to anything.
  assert.match(wrapperCode, /\*\)\s*\n\s*die "unknown verb/);
});

// --- corrupt state must fail closed, never silently reset --------------------
test('a corrupt pr store throws instead of resetting to {}', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-store-'));
  try {
    const p = join(dir, 'github-prs.json');
    writeFileSync(p, '{ this is not json');
    assert.throws(() => loadPrStore(p), SyntaxError, 'a corrupt store must not read as empty');

    writeFileSync(p, JSON.stringify(['not', 'an', 'object']));
    assert.throws(() => loadPrStore(p), /fail closed/);

    // A valid store still round-trips.
    savePrStore({ 'o/r#1': { headSha: 'abc' } }, p);
    assert.deepEqual(loadPrStore(p), { 'o/r#1': { headSha: 'abc' } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt checks store throws instead of silently discarding check ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-checks-'));
  try {
    const p = join(dir, 'github-checks.json');
    writeFileSync(p, 'nope');
    assert.throws(() => loadChecks(p), SyntaxError);
    writeFileSync(p, '[]');
    assert.throws(() => loadChecks(p), /fail closed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('savePrStore writes atomically and leaves no tmp file behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-atomic-'));
  try {
    const p = join(dir, 'github-prs.json');
    savePrStore({ a: 1 }, p);
    assert.deepEqual(readdirSync(dir), ['github-prs.json'], 'no .tmp residue');
    assert.equal(loadPrStore(p).a, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- state must be bounded ----------------------------------------------------
test('the checks store is pruned to a ceiling on every save', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-prune-'));
  try {
    const p = join(dir, 'github-checks.json');
    const store = {};
    for (let i = 0; i < MAX_CHECK_ENTRIES + 50; i += 1) store[`o/r#${i}#${'a'.repeat(40)}`] = { i };
    saveChecks(store, p);
    const after = Object.keys(loadChecks(p));
    assert.equal(after.length, MAX_CHECK_ENTRIES);
    // The newest entries are the ones worth keeping.
    assert.ok(after.includes(`o/r#${MAX_CHECK_ENTRIES + 49}#${'a'.repeat(40)}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pruneChecks leaves a small store untouched', () => {
  const small = { a: 1, b: 2 };
  assert.deepEqual(pruneChecks({ ...small }), small);
});

test('the ledger rotates instead of growing without bound', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ledger-'));
  try {
    const p = join(dir, 'ledger.jsonl');
    for (let i = 0; i < 10; i += 1) appendLedger({ n: i }, p);
    assert.equal(loadLedger(p).length, 10, 'the active segment holds every entry');

    // Force a rotation with a ceiling far below the current size. The whole
    // active segment moves aside as one generation; nothing is truncated.
    assert.equal(rotateLedgerIfNeeded(p, 10), true);
    assert.equal(existsSync(p), false, 'the active segment was rotated away');
    assert.ok(existsSync(`${p}.1`), 'the previous generation is retained');

    appendLedger({ n: 10 }, p);
    const seen = loadLedger(p).map((e) => e.n);
    assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      'history is continuous across the rotation, oldest generation first');

    const paths = loadLedgerPaths(p);
    assert.equal(paths[paths.length - 1], p, 'the active segment is read last');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger rotation drops the oldest generation past the ceiling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ledger-cap-'));
  try {
    const p = join(dir, 'ledger.jsonl');
    // Each generation holds one entry, so rotating repeatedly is deterministic.
    for (let g = 0; g < MAX_LEDGER_GENERATIONS + 3; g += 1) {
      appendLedger({ n: g }, p);
      rotateLedgerIfNeeded(p, 1, MAX_LEDGER_GENERATIONS);
    }
    const generations = readdirSync(dir).filter((f) => f.startsWith('ledger.jsonl.'));
    assert.ok(generations.length <= MAX_LEDGER_GENERATIONS - 1,
      `expected at most ${MAX_LEDGER_GENERATIONS - 1} retained generations, saw ${generations.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- receipts must be able to name the config that produced them --------------
test('main() passes the loaded configHash through instead of hardcoding null', () => {
  const handlerOpts = appJs.slice(appJs.indexOf('const handler = createHandler('), appJs.indexOf('const port ='));
  assert.doesNotMatch(handlerOpts, /configHash:\s*null/, 'handler opts must carry a real configHash');
  assert.match(handlerOpts, /configHash,/);
  const pollOpts = appJs.slice(appJs.indexOf('const pollOpts = {'));
  assert.doesNotMatch(pollOpts, /configHash:\s*null/, 'poll opts must carry a real configHash');
});

// --- fail-closed on process-level faults --------------------------------------
test('the entrypoint installs rejection and exception handlers', () => {
  assert.match(appJs, /process\.on\('unhandledRejection'/);
  assert.match(appJs, /process\.on\('uncaughtException'/);
  assert.match(appJs, /main\(\)\.catch\(/, 'main() must be caught, not invoked bare');
});

// --- installed credentials must be validated before the host is touched -------
test('install.sh validates the private key mode and App ID before installing', () => {
  assert.match(installSh, /expected root:sentinel 0640/);
  assert.match(installSh, /GITHUB_APP_ID/);
  assert.match(installSh, /is not numeric/);
  assert.match(installSh, /systemd-analyze verify/);
});

test('no committed artefact carries key material', () => {
  // A belt-and-braces check: the deploy slice must not embed a PEM.
  for (const f of [
    'ops/deploy/install.sh',
    'ops/deploy/sentinel-deploy',
    'ops/deploy/github-app.env.example',
    'ops/deploy/sentinel-github-app.service',
  ]) {
    assert.doesNotMatch(read(f), /-----BEGIN [A-Z ]*PRIVATE KEY-----/, `${f} must not embed a key`);
  }
});

test('the env example points the tunnel at loopback', () => {
  assert.match(envExample, /127\.0\.0\.1/);
});

test('the deploy slice still ships, and the tree is intact', () => {
  for (const f of [
    'ops/deploy/install.sh',
    'ops/deploy/install-deploy-sudo.sh',
    'ops/deploy/sentinel-deploy',
    'ops/deploy/sentinel-github-app.service',
    'ops/deploy/github-app.env.example',
  ]) {
    assert.ok(existsSync(join(ROOT, f)), `${f} must exist`);
  }
});
