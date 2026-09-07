// Minimal GitHub platform client (token fetch, no gh CLI): exactly the
// calls the App slice needs. `fetchImpl` is injectable for tests.
//
// Auth modes:
//   { token } — plain Bearer (PAT or a pre-minted installation token).
//   { appId, privateKeyPem, installationId? } — GitHub App mode: mint a
//     short-lived RS256 App JWT (node:crypto, zero deps), discover the
//     installation when the id is absent (GET /app/installations), then
//     exchange it for an installation token
//     (POST /app/installations/{id}/access_tokens) used for all calls.
import { createPrivateKey, sign } from 'node:crypto';

const API = 'https://api.github.com';

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

// Mint a GitHub App JWT: header.typ JWT / alg RS256, payload iss/iat/exp.
// exp stays within GitHub's 10-minute window (iat-60s, 9-minute life).
// nowSec is injectable for deterministic tests.
export function createAppJwt({ appId, privateKeyPem, nowSec, skewSec = 60, ttlSec = 540 } = {}) {
  if (!appId || !privateKeyPem) throw new Error('createAppJwt requires appId and privateKeyPem');
  const now = nowSec ?? Math.floor(Date.now() / 1000);
  const iat = now - skewSec;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: String(appId), iat, exp: iat + ttlSec }));
  const signingInput = `${header}.${payload}`;
  const sig = sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), createPrivateKey(privateKeyPem));
  return `${signingInput}.${b64url(sig)}`;
}

export function createPlatform({ token, appId, privateKeyPem, installationId, fetchImpl } = {}) {
  const fetchFn = fetchImpl || fetch;
  const appMode = Boolean(appId && privateKeyPem);

  async function rawReq(path, { method = 'GET', accept, body, auth } = {}) {
    const res = await fetchFn(`${API}${path}`, {
      method,
      headers: {
        Accept: accept || 'application/vnd.github+json',
        Authorization: auth,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`GitHub API ${method} ${path}: ${res.status}`);
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  // Short-lived installation token cache (refreshed 60s before expiry).
  let cached = null;
  async function installationToken() {
    if (cached && Date.now() < cached.expiresAtMs - 60_000) return cached.token;
    const jwt = createAppJwt({ appId, privateKeyPem });
    let id = installationId;
    if (!id) {
      const installs = await rawReq('/app/installations', { auth: `Bearer ${jwt}` });
      if (!Array.isArray(installs) || installs.length === 0 || installs[0] == null || installs[0].id == null) {
        throw new Error('GitHub App auth failed: no installations found for this App');
      }
      id = installs[0].id;
    }
    const issued = await rawReq(`/app/installations/${id}/access_tokens`, {
      method: 'POST',
      auth: `Bearer ${jwt}`,
    });
    if (!issued || !issued.token) throw new Error('GitHub App auth failed: access_tokens returned no token');
    cached = {
      token: issued.token,
      expiresAtMs: issued.expires_at ? Date.parse(issued.expires_at) : Date.now() + 50 * 60_000,
    };
    return cached.token;
  }

  async function req(path, opts = {}) {
    if (appMode) {
      const itoken = await installationToken();
      return rawReq(path, { ...opts, auth: `Bearer ${itoken}` });
    }
    if (!token) throw new Error('createPlatform requires { token } or { appId, privateKeyPem }');
    return rawReq(path, { ...opts, auth: `Bearer ${token}` });
  }

  return {
    getPR: (repo, pr) => req(`/repos/${repo}/pulls/${pr}`),
    getDiff: (repo, pr) => req(`/repos/${repo}/pulls/${pr}`, { accept: 'application/vnd.github.v3.diff' }),
    listComments: (repo, pr) => req(`/repos/${repo}/issues/${pr}/comments?per_page=100`),
    postComment: (repo, pr, body) => req(`/repos/${repo}/issues/${pr}/comments`, { method: 'POST', body: { body } }),
    patchComment: (repo, commentId, body) => req(`/repos/${repo}/issues/comments/${commentId}`, { method: 'PATCH', body: { body } }),
  };
}
