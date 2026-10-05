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

export function createPlatform({
  token, appId, privateKeyPem, installationId, fetchImpl,
  timeoutMs = 20_000, maxRetries = 2, retryBaseMs = 250, sleepImpl,
} = {}) {
  const fetchFn = fetchImpl || fetch;
  const appMode = Boolean(appId && privateKeyPem);
  const sleep = sleepImpl || ((ms) => new Promise((r) => setTimeout(r, ms)));
  // Statuses worth a second attempt: rate limiting and transient upstream.
  // Everything else (401/403/404/422) is deterministic and must fail fast so
  // callers see the real error instead of a masked one.
  const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

  async function rawReq(path, { method = 'GET', accept, body, auth } = {}) {
    // One AbortSignal per attempt. Without it a hung connection holds the
    // webhook open indefinitely, which is a denial-of-service on our own
    // process rather than a GitHub problem.
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetchFn(`${API}${path}`, {
          method,
          headers: {
            Accept: accept || 'application/vnd.github+json',
            Authorization: auth,
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const reason = err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : err?.message || String(err);
        if (attempt < maxRetries) {
          await sleep(retryBaseMs * 2 ** attempt);
          continue;
        }
        throw new Error(`GitHub API ${method} ${path}: ${reason}`);
      }
      clearTimeout(timer);
      if (res.ok) {
        const ct = res.headers.get('content-type') || '';
        return ct.includes('application/json') ? res.json() : res.text();
      }
      if (RETRYABLE.has(res.status) && attempt < maxRetries) {
        await sleep(retryBaseMs * 2 ** attempt);
        continue;
      }
      const err = new Error(`GitHub API ${method} ${path}: ${res.status}`);
      err.status = res.status;
      throw err;
    }
  }

  // Short-lived installation token cache (refreshed 60s before expiry).
  let cached = null;
  function invalidateToken() { cached = null; }
  async function installationToken({ force = false } = {}) {
    if (!force && cached && Date.now() < cached.expiresAtMs - 60_000) return cached.token;
    const jwt = createAppJwt({ appId, privateKeyPem });
    let id = installationId;
    if (!id) {
      const installs = await rawReq('/app/installations', { auth: `Bearer ${jwt}` });
      if (!Array.isArray(installs) || installs.length === 0 || installs[0] == null || installs[0].id == null) {
        throw new Error('GitHub App auth failed: no installations found for this App');
      }
      // "the app resolves the sole installation when it is absent" is only true
      // while there IS a sole installation. Binding silently to whichever org
      // GitHub returns first would review the wrong organisation's repos.
      if (installs.length > 1) {
        const names = installs.map((i) => i?.account?.login || `id:${i?.id}`).join(', ');
        throw new Error(
          `GitHub App auth failed: expected exactly 1 installation, found ${installs.length} (${names}). `
          + 'Set GITHUB_INSTALLATION_ID explicitly.',
        );
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
      try {
        return await rawReq(path, { ...opts, auth: `Bearer ${itoken}` });
      } catch (err) {
        // A cached installation token can be revoked, expire early, or hit
        // clock skew. Retrying the same dead token 500s every webhook for up to
        // ~59 minutes, so discard it and mint exactly one replacement.
        if (err?.status !== 401) throw err;
        invalidateToken();
        const fresh = await installationToken({ force: true });
        return rawReq(path, { ...opts, auth: `Bearer ${fresh}` });
      }
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
    getBranch: (repo, branch = 'main') => req(`/repos/${repo}/branches/${encodeURIComponent(branch)}`),
    getCompareDiff: (repo, base, head) => req(`/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, { accept: 'application/vnd.github.v3.diff' }),
    listOpenIssues: async (repo) => {
      const data = await req(`/repos/${repo}/issues?state=open&per_page=100`);
      return Array.isArray(data) ? data.filter((item) => !item?.pull_request) : [];
    },
    createIssue: (repo, { title, body }) => req(`/repos/${repo}/issues`, { method: 'POST', body: { title, body } }),
    getPR: (repo, pr) => req(`/repos/${repo}/pulls/${pr}`),
    getDiff: (repo, pr) => req(`/repos/${repo}/pulls/${pr}`, { accept: 'application/vnd.github.v3.diff' }),
    listComments: async (repo, pr) => {
      // Page through issue comments instead of reading only the first 100. The
      // one-card-per-PR contract means findOwnComment must be able to see our
      // own `<!-- sentinel-verdict -->` card even on a PR that has accumulated
      // more than a page of other people's comments; otherwise a second
      // top-level comment is posted on every review.
      const out = [];
      const maxPages = 10;
      for (let page = 1; page <= maxPages; page += 1) {
        const batch = await req(`/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`);
        if (!Array.isArray(batch) || batch.length === 0) break;
        out.push(...batch);
        if (batch.length < 100) break;
      }
      return out;
    },
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
          ...(params.output !== undefined ? { output: params.output } : {}),
        },
      });
    },
  };
}
