export const GITHUB_APP_CONTRACT = Object.freeze({
  version: 'github-app-contract/1.0',
  permissions: Object.freeze({
    contents: 'read',
    pull_requests: 'read',
    issues: 'write',
    actions: 'read',
    checks: 'write',
  }),
  events: Object.freeze([
    'installation',
    'installation_repositories',
    'pull_request',
    'workflow_run',
  ]),
});

function stableObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]));
}

export function assertGitHubAppContract(actual) {
  if (!actual || typeof actual !== 'object') {
    throw new Error('GitHub App contract missing (fail closed)');
  }
  const wantPermissions = JSON.stringify(stableObject(GITHUB_APP_CONTRACT.permissions));
  const gotPermissions = JSON.stringify(stableObject(actual.permissions));
  if (gotPermissions !== wantPermissions) {
    throw new Error(`GitHub App permission drift detected: expected ${wantPermissions}, got ${gotPermissions}`);
  }
  const wantEvents = [...GITHUB_APP_CONTRACT.events].sort();
  const gotEvents = Array.isArray(actual.events) ? [...actual.events].sort() : [];
  if (JSON.stringify(gotEvents) !== JSON.stringify(wantEvents)) {
    throw new Error(`GitHub App event drift detected: expected ${JSON.stringify(wantEvents)}, got ${JSON.stringify(gotEvents)}`);
  }
  return true;
}
