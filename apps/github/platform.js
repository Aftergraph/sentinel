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
import { GITHUB_APP_CONTRACT } from './contract.js';
import { createCredentialIssuer } from './credentials.js';

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

  // Short-lived installation tokens are cached per repository and refreshed
  // 60s before expiry. Tokens are narrowed to exactly one repository plus the
  // machine-readable Sentinel permission contract.
  const tokenCache = new Map();
  let discoveredInstallationId = installationId || null;

  function repoNameFromPath(path) {
    const m = /^\/repos\/[^/]+\/([^/?]+)/.exec(path);
    if (!m) throw new Error(`GitHub App request is not repository-scoped: ${path} (fail closed)`);
    return decodeURIComponent(m[1]);
  }

  async function resolvedInstallationId() {
    if (discoveredInstallationId) return discoveredInstallationId;
    const jwt = createAppJwt({ appId, privateKeyPem });
    const installs = await rawReq('/app/installations', { auth: `Bearer ${jwt}` });
    if (!Array.isArray(installs) || installs.length === 0 || installs[0] == null || installs[0].id == null) {
      throw new Error('GitHub App auth failed: no installations found for this App');
    }
    discoveredInstallationId = installs[0].id;
    return discoveredInstallationId;
  }

  async function installationToken(repoName) {
    const cached = tokenCache.get(repoName);
    if (cached && Date.now() < cached.expiresAtMs - 60_000) return cached.token;
    const id = await resolvedInstallationId();
    const issuer = createCredentialIssuer({
      appId,
      privateKeyPem,
      fetchImpl: fetchFn,
      jwtFactory: createAppJwt,
      apiBase: API,
    });
    const issued = await issuer.issue({
      installationId: id,
      repositories: [repoName],
      permissions: GITHUB_APP_CONTRACT.permissions,
    });
    tokenCache.set(repoName, {
      token: issued.token,
      fingerprint: issued.fingerprint,
      expiresAtMs: issued.expiresAt ? Date.parse(issued.expiresAt) : Date.now() + 50 * 60_000,
    });
    return issued.token;
  }

  async function req(path, opts = {}) {
    if (appMode) {
      const itoken = await installationToken(repoNameFromPath(path));
      return rawReq(path, { ...opts, auth: `Bearer ${itoken}` });
    }
    if (!token) throw new Error('createPlatform requires { token } or { appId, privateKeyPem }');
    return rawReq(path, { ...opts, auth: `Bearer ${token}` });
  }

  return {
    listInstallationRepositories: async () => {
      const data = await req('/installation/repositories?per_page=100');
      return Array.isArray(data?.repositories) ? data.repositories : [];
    },
    listOpenPRs: async (repo) => {
      const data = await req(`/repos/${repo}/pulls?state=open&per_page=100`);
      return Array.isArray(data) ? data : [];
    },
    getPR: (repo, pr) => req(`/repos/${repo}/pulls/${pr}`),
    getDiff: (repo, pr) => req(`/repos/${repo}/pulls/${pr}`, { accept: 'application/vnd.github.v3.diff' }),
    listComments: (repo, pr) => req(`/repos/${repo}/issues/${pr}/comments?per_page=100`),
    postComment: (repo, pr, body) => req(`/repos/${repo}/issues/${pr}/comments`, { method: 'POST', body: { body } }),
    patchComment: (repo, commentId, body) => req(`/repos/${repo}/issues/comments/${commentId}`, { method: 'PATCH', body: { body } }),
    listWorkflowRunsForHead: async (repo, headSha) => {
      const data = await req(`/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100`);
      return Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
    },
    getFileContent: async (repo, path, ref) => {
      const data = await req(`/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
      if (!data || data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string') {
        throw new Error('GitHub contents response is not a base64 file (fail closed)');
      }
      return Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
    },
    createCheckRun: (params = {}) => {
      const repo = params.repo;
      if (!repo) throw new Error('createCheckRun requires repo');
      return req(`/repos/${repo}/check-runs`, {
        method: 'POST',
        body: {
          name: params.name,
          head_sha: params.head_sha,
          status: params.status,
          conclusion: params.conclusion,
          external_id: params.external_id,
          output: params.output,
        },
      });
    },
    updateCheckRun: (id, params = {}) => {
      const repo = params.repo;
      if (!repo) throw new Error('updateCheckRun requires repo');
      return req(`/repos/${repo}/check-runs/${id}`, {
        method: 'PATCH',
        body: {
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(params.status !== undefined ? { status: params.status } : {}),
          ...(params.conclusion !== undefined ? { conclusion: params.conclusion } : {}),
          ...(params.external_id !== undefined ? { external_id: params.external_id } : {}),
          ...(params.output !== undefined ? { output: params.output } : {}),
        },
      });
    },
  };
}
