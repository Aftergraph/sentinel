import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeyPairSync,
  verify,
  createPublicKey,
} from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppJwt, createPlatform } from '../apps/github/platform.js';
import { createPlatformFromEnv } from '../apps/github/app.js';

const H1 = 'a'.repeat(40);
const B = 'c'.repeat(40);

function testKeys() {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

function decodeSegment(seg) {
  return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
}

function jsonResponse(obj) {
  return { ok: true, headers: { get: () => 'application/json' }, json: async () => obj };
}

test('github auth: App JWT has three segments with an RS256 header', () => {
  const { publicKey, privateKey } = testKeys();
  const nowSec = 1_700_000_000;
  const jwt = createAppJwt({ appId: '12345', privateKeyPem: privateKey, nowSec });
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);

  assert.deepEqual(decodeSegment(parts[0]), { alg: 'RS256', typ: 'JWT' });
  const payload = decodeSegment(parts[1]);
  assert.equal(payload.iss, '12345');
  assert.equal(payload.iat, nowSec - 60);
  assert.equal(payload.exp, payload.iat + 540);
  assert.ok(payload.exp - payload.iat <= 600);

  const signingInput = `${parts[0]}.${parts[1]}`;
  const ok = verify(
    'RSA-SHA256',
    Buffer.from(signingInput, 'utf8'),
    createPublicKey(publicKey),
    Buffer.from(parts[2], 'base64url'),
  );
  assert.equal(ok, true);
});

test('github auth: App mode discovers the installation then calls the API with its token', async () => {
  const { privateKey } = testKeys();
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ method: init.method, url, auth: init.headers.Authorization });
    if (url === 'https://api.github.com/app/installations') {
      return jsonResponse([{ id: 99 }]);
    }
    if (url === 'https://api.github.com/app/installations/99/access_tokens') {
      assert.equal(init.method, 'POST');
      return jsonResponse({ token: 'inst-abc', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    if (url === 'https://api.github.com/repos/o/r/pulls/7') {
      return jsonResponse({ head: { sha: H1 }, base: { sha: B } });
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
  const p = createPlatform({ appId: '12345', privateKeyPem: privateKey, fetchImpl: fakeFetch });
  const pr = await p.getPR('o/r', 7);
  assert.equal(pr.head.sha, H1);

  const discovery = seen.find((s) => s.url.endsWith('/app/installations'));
  assert.ok(discovery);
  assert.equal(discovery.auth.split('.').length, 3); // Bearer App JWT
  const apiCall = seen.find((s) => s.url.endsWith('/repos/o/r/pulls/7'));
  assert.equal(apiCall.auth, 'Bearer inst-abc');
});

test('github auth: explicit installationId skips discovery', async () => {
  const { privateKey } = testKeys();
  const urls = [];
  const fakeFetch = async (url, init) => {
    urls.push([init.method, url]);
    if (url.endsWith('/access_tokens')) {
      return jsonResponse({ token: 'inst-x', expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    return jsonResponse({ head: { sha: H1 }, base: { sha: B } });
  };
  const p = createPlatform({ appId: '1', privateKeyPem: privateKey, installationId: 42, fetchImpl: fakeFetch });
  await p.getPR('o/r', 7);
  assert.ok(urls.some(([m, u]) => m === 'POST' && u.endsWith('/app/installations/42/access_tokens')));
  assert.ok(!urls.some(([, u]) => u === 'https://api.github.com/app/installations'));
});

test('github auth: plain token falls back to direct Bearer use', async () => {
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization });
    return jsonResponse({ head: { sha: H1 }, base: { sha: B } });
  };
  const p = createPlatform({ token: 'pat-123', fetchImpl: fakeFetch });
  await p.getPR('o/r', 7);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].auth, 'Bearer pat-123');
});

test('github auth: boot fails closed when neither App creds nor token are present', () => {
  assert.throws(() => createPlatformFromEnv({}), /GITHUB_APP_ID \+ GITHUB_APP_KEY_FILE|GITHUB_TOKEN/);
  assert.throws(
    () => createPlatformFromEnv({ GITHUB_APP_ID: '1' }),
    /GITHUB_APP_ID \+ GITHUB_APP_KEY_FILE|GITHUB_TOKEN/,
  );
  assert.throws(
    () => createPlatformFromEnv({ GITHUB_APP_ID: '1', GITHUB_APP_KEY_FILE: '/no/such/key.pem' }),
    /cannot read GITHUB_APP_KEY_FILE/,
  );
});

test('github auth: boot prefers App JWT env over a plain token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-ghauth-'));
  try {
    const { privateKey } = testKeys();
    const keyFile = join(dir, 'app-key.pem');
    writeFileSync(keyFile, privateKey);
    const urls = [];
    const fakeFetch = async (url, init) => {
      urls.push(url);
      if (url === 'https://api.github.com/app/installations') return jsonResponse([{ id: 7 }]);
      if (url.endsWith('/access_tokens')) {
        return jsonResponse({ token: 'inst-prefer', expires_at: new Date(Date.now() + 3600_000).toISOString() });
      }
      return jsonResponse({ head: { sha: H1 }, base: { sha: B } });
    };
    const env = {
      GITHUB_APP_ID: '12345',
      GITHUB_APP_KEY_FILE: keyFile,
      GITHUB_TOKEN: 'pat-should-lose',
    };
    const p = createPlatformFromEnv(env, { fetchImpl: fakeFetch });
    await p.getPR('o/r', 7);
    // Discovery proves the App-JWT path was taken, not the plain token.
    assert.ok(urls.includes('https://api.github.com/app/installations'));

    const direct = [];
    const tokenFetch = async (url, init) => {
      direct.push({ url, auth: init.headers.Authorization });
      return jsonResponse({ head: { sha: H1 }, base: { sha: B } });
    };
    const p2 = createPlatformFromEnv({ GITHUB_TOKEN: 'pat-only' }, { fetchImpl: tokenFetch });
    await p2.getPR('o/r', 7);
    assert.deepEqual(direct.map((d) => d.auth), ['Bearer pat-only']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
