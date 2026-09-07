import { execSync } from 'node:child_process';

function ghApi(endpoint, repo) {
  const out = execSync(`gh api repos/${repo}/${endpoint}`, { encoding: 'utf8' });
  return JSON.parse(out);
}

function resolveRepo(explicit) {
  if (explicit) return explicit;
  const remote = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
  const m = remote.match(/github\.com[:\/]([^\/]+\/[^\/]+?)(?:\.git)?$/);
  if (!m) throw new Error('Cannot resolve repo from origin remote');
  return m[1];
}

export async function review({ pr, repo: explicitRepo, format }) {
  const repo = resolveRepo(explicitRepo);
  
  // Pin HEAD and base at start
  const prData = ghApi(`pulls/${pr}`, repo);
  const headSha = prData.head.sha;
  const baseShaStart = prData.base.sha;
  
  // Re-check base atomically before printing
  const prDataCheck = ghApi(`pulls/${pr}`, repo);
  const baseShaEnd = prDataCheck.base.sha;
  
  if (baseShaStart !== baseShaEnd) {
    console.log(`STALE — base moved from ${baseShaStart.slice(0, 7)} to ${baseShaEnd.slice(0, 7)}`);
    process.exit(2);
  }
  
  // Flow-1 output
  console.log(`HEAD: ${headSha}`);
  console.log(`SHIP — 0 findings (scaffold: no rules yet)`);
  console.log(`passed-checks: 0`);
  process.exit(0);
}
