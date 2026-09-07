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

const RULE_IDS = [
  'no-unauthenticated-api-endpoints',
  'no-secrets-in-cicd-config',
  'require-transaction-rollback-on-failure',
  'no-unindexed-schema-migration-on-large-tables',
  'no-n-plus-one-queries-in-api-resolvers',
  'require-dataloader-or-eager-load-for-nested-fetches',
];

async function loadRules() {
  const rules = [];
  for (const id of RULE_IDS) {
    const mod = await import(`./rules/${id}.js`);
    rules.push(mod.check);
  }
  return rules;
}

export async function review({ pr, repo: explicitRepo, format }) {
  const repo = resolveRepo(explicitRepo);

  // Pin HEAD and base at start
  const prData = ghApi(`pulls/${pr}`, repo);
  const headSha = prData.head.sha;
  const baseShaStart = prData.base.sha;

  // Fetch diff
  const diffText = execSync(
    `gh api repos/${repo}/pulls/${pr} -H "Accept: application/vnd.github.v3.diff"`,
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  );

  // Run all rules
  const rules = await loadRules();
  const findings = [];
  for (const check of rules) {
    findings.push(...check(diffText));
  }

  // Sort deterministically: file, then line, then ruleId
  findings.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 :
    a.line - b.line || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)
  );

  // Re-check base atomically before printing
  const prDataCheck = ghApi(`pulls/${pr}`, repo);
  const baseShaEnd = prDataCheck.base.sha;

  if (baseShaStart !== baseShaEnd) {
    console.log(`STALE — base moved from ${baseShaStart.slice(0, 7)} to ${baseShaEnd.slice(0, 7)}`);
    process.exit(2);
  }

  console.log(`HEAD: ${headSha}`);

  if (findings.length > 0) {
    console.log(`DO NOT SHIP — ${findings.length} finding(s)`);
    for (const f of findings) {
      console.log(`  ${f.file}:${f.line} [${f.ruleId}] ${f.evidence}`);
    }
    process.exit(1);
  }

  console.log(`SHIP — 0 findings`);
  console.log(`passed-checks: ${RULE_IDS.length}`);
  process.exit(0);
}
