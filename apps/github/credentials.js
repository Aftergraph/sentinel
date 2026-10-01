import { createHash } from 'node:crypto';

const API = 'https://api.github.com';

function fingerprint(token) {
  return 'ghinst_' + createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
}

function normalizeRepositories(repositories) {
  if (!Array.isArray(repositories) || repositories.length === 0) {
    throw new Error('credential issuer requires at least one repository (fail closed)');
  }
  const out = [];
  for (const repo of repositories) {
    if (typeof repo !== 'string' || repo.trim() === '' || repo.includes('/')) {
      throw new Error('credential issuer repositories must be repository names, not owner/name (fail closed)');
    }
    if (!out.includes(repo)) out.push(repo);
  }
  return out;
}

export function createCredentialIssuer({
  appId,
  privateKeyPem,
  fetchImpl = fetch,
  jwtFactory,
  apiBase = API,
} = {}) {
  if (!appId || !privateKeyPem) {
    throw new Error('credential issuer requires appId and privateKeyPem (fail closed)');
  }
  if (typeof jwtFactory !== 'function') {
    throw new Error('credential issuer requires jwtFactory (fail closed)');
  }

  return Object.freeze({
    async issue({ installationId, repositories, permissions } = {}) {
      if (installationId === undefined || installationId === null || installationId === '') {
        throw new Error('credential issuer requires installationId (fail closed)');
      }
      const repos = normalizeRepositories(repositories);
      if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
        throw new Error('credential issuer requires permissions (fail closed)');
      }
      const jwt = jwtFactory({ appId, privateKeyPem });
      const res = await fetchImpl(`${apiBase}/app/installations/${installationId}/access_tokens`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ repositories: repos, permissions }),
      });
      if (!res.ok) {
        throw new Error(`GitHub installation token issuance failed: ${res.status}`);
      }
      const issued = await res.json();
      if (!issued || typeof issued.token !== 'string' || issued.token === '') {
        throw new Error('GitHub installation token issuance returned no token (fail closed)');
      }
      return Object.freeze({
        token: issued.token,
        expiresAt: issued.expires_at || null,
        fingerprint: fingerprint(issued.token),
      });
    },
  });
}
