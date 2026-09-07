import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createConsoleServer } from '../console/server.js';

const EXPECTED_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; img-src 'self'";
const EXPECTED_PERMISSIONS = 'camera=(), microphone=(), geolocation=()';

async function boot(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-secheaders-'));
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
    base,
    async get(path) {
      const res = await fetch(`${base}${path}`);
      const text = await res.text();
      return { status: res.status, headers: res.headers, text };
    },
    async close() {
      await new Promise((r) => server.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function assertSecurityHeaders(headers, label) {
  assert.equal(headers.get('x-content-type-options'), 'nosniff', `${label}: X-Content-Type-Options`);
  assert.equal(headers.get('x-frame-options'), 'DENY', `${label}: X-Frame-Options`);
  assert.equal(headers.get('referrer-policy'), 'no-referrer', `${label}: Referrer-Policy`);
  assert.equal(headers.get('permissions-policy'), EXPECTED_PERMISSIONS, `${label}: Permissions-Policy`);
  assert.equal(headers.get('content-security-policy'), EXPECTED_CSP, `${label}: exact CSP`);
  // Plain HTTP: HSTS must be absent.
  assert.equal(headers.get('strict-transport-security'), null, `${label}: HSTS absent over plain HTTP`);
  // Every path carries the request id alongside the hardening headers.
  assert.ok(headers.get('x-request-id'), `${label}: X-Request-Id present`);
}

test('security headers present on root, app.js, healthz, and 404; HSTS absent; exact CSP', async () => {
  const c = await boot();
  try {
    const root = await c.get('/');
    assert.equal(root.status, 200);
    assertSecurityHeaders(root.headers, 'GET /');

    const js = await c.get('/app.js');
    assert.equal(js.status, 200);
    assertSecurityHeaders(js.headers, 'GET /app.js');

    const hz = await c.get('/api/healthz');
    assert.equal(hz.status, 200);
    assertSecurityHeaders(hz.headers, 'GET /api/healthz');

    const nf = await c.get('/__no_such_path_404__');
    assert.equal(nf.status, 404);
    assertSecurityHeaders(nf.headers, 'GET 404');
  } finally { await c.close(); }
});
