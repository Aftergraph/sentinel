// S2 slice 2: read-only GET /api/context/blast console route, including
// inside-repo escape rejection. Follows the test/console-health.test.mjs
// boot pattern (hermetic tmpdir server, fetch helper).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createConsoleServer } from '../console/server.js';

async function boot(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-blast-'));
  const repoDir = join(dir, 'repo');
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, 'app.js'), 'export function run(x) {\n  return x;\n}\n');
  writeFileSync(join(repoDir, 'cli.js'), "import { run } from './app.js';\nconsole.log(run(1));\n");
  const ledgerPath = join(dir, 'ledger.jsonl');
  const handler = createConsoleServer({
    ledgerPath,
    memoryPath: join(dir, 'mem.jsonl'),
    // Hermetic: never discover cwd config (a stray file would poison results).
    configPath: join(dir, 'sentinel.config.json'),
  });
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    dir,
    repoDir,
    async call(method, path, body, headers = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json() };
    },
    async close() {
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const q = (params) => `/api/context/blast?${new URLSearchParams(params).toString()}`;

test('context/blast: advisory files+symbols+stats for a repo file', async () => {
  const c = await boot();
  try {
    const { status, json } = await c.call('GET', q({ repoDir: c.repoDir, file: 'app.js' }));
    assert.equal(status, 200);
    assert.equal(json.advisory, true);
    assert.ok(typeof json.note === 'string' && json.note.length > 0);
    assert.equal(json.file, 'app.js');
    assert.deepEqual(json.files, ['app.js', 'cli.js']);
    assert.deepEqual(json.symbols, []);
    assert.equal(json.stats.scanned, 2);
  } finally { await c.close(); }
});

test('context/blast: symbol + line scoping', async () => {
  const c = await boot();
  try {
    const { status, json } = await c.call('GET', q({ repoDir: c.repoDir, file: 'app.js', symbol: 'run', line: '1' }));
    assert.equal(status, 200);
    assert.deepEqual(json.symbols, [{ file: 'app.js', name: 'run' }]);
    assert.equal(json.symbol, 'run');
    assert.equal(json.line, 1);
  } finally { await c.close(); }
});

test('context/blast: escape rejection returns error JSON, never throws', async () => {
  const c = await boot();
  try {
    for (const params of [
      { repoDir: c.repoDir, file: '../evil.js' },
      { repoDir: c.repoDir, file: 'sub/../../evil.js' },
      { repoDir: c.repoDir, file: '/etc/passwd' },
    ]) {
      const { status, json } = await c.call('GET', q(params));
      assert.equal(status, 400);
      assert.ok(typeof json.error === 'string' && json.error.length > 0);
    }
    // Missing params and bad repoDir also fail as error JSON.
    assert.equal((await c.call('GET', q({ repoDir: c.repoDir }))).status, 400);
    assert.equal((await c.call('GET', q({ file: 'app.js' }))).status, 400);
    assert.equal((await c.call('GET', q({ repoDir: join(c.dir, 'nope'), file: 'app.js' }))).status, 400);
    // Unknown-but-inside file is a valid query with empty scope.
    const empty = await c.call('GET', q({ repoDir: c.repoDir, file: 'ghost.js' }));
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.files, []);
  } finally { await c.close(); }
});
