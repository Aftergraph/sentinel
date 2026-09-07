import { execSync } from 'node:child_process';
import { load, partition, append as memAppend, fingerprint } from './memory.js';

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
  'no-destructive-migration-without-backup-verification',
  'require-dataloader-or-eager-load-for-nested-fetches',
];

const SEVERITY_MAP = {
  'no-unauthenticated-api-endpoints': 'security',
  'no-secrets-in-cicd-config': 'security',
  'require-transaction-rollback-on-failure': 'reliability',
  'no-unindexed-schema-migration-on-large-tables': 'data',
  'no-n-plus-one-queries-in-api-resolvers': 'performance',
  'no-destructive-migration-without-backup-verification': 'data',
  'require-dataloader-or-eager-load-for-nested-fetches': 'performance',
};

export async function loadRules() {
  const rules = [];
  for (const id of RULE_IDS) {
    const mod = await import(`./rules/${id}.js`);
    rules.push(mod.check);
  }
  return rules;
}

// Pure: exact-head freshness gate. A verdict is only valid for the HEAD
// it reviewed — if either end moved mid-review the evidence is stale.
// ponytail: string compare is the whole check; SHA equality needs no hashing.
export function checkFreshness(start, end) {
  const moved = [];
  if (start.headSha !== end.headSha) moved.push(`head moved from ${start.headSha} to ${end.headSha}`);
  if (start.baseSha !== end.baseSha) moved.push(`base moved from ${start.baseSha} to ${end.baseSha}`);
  return moved.length === 0 ? { fresh: true } : { fresh: false, reason: moved.join('; ') };
}

// Pure: compute verdict + structured output from findings + resolutions.
export function computeVerdict(findings, resolutions, meta) {
  const { blocking, silenced } = partition(findings, resolutions);
  const verdict = blocking.length === 0 ? 'SHIP' : 'DO_NOT_SHIP';
  return {
    verdict,
    headSha: meta.headSha,
    baseSha: meta.baseSha,
    rulePackVersion: meta.rulePackVersion || '1.0.0',
    blocking,
    silenced,
    checksPassed: RULE_IDS.length,
  };
}

// SARIF 2.1.0 envelope with verdict wrapper.
export function toSarif(result) {
  const sarifResults = [];
  for (const f of [...result.blocking, ...result.silenced]) {
    const level = SEVERITY_MAP[f.ruleId] === 'security' ? 'error'
      : SEVERITY_MAP[f.ruleId] === 'reliability' ? 'error'
      : 'warning';
    sarifResults.push({
      ruleId: f.ruleId,
      level,
      message: { text: f.evidence },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: f.file },
          region: { startLine: f.line }
        }
      }],
      properties: {
        status: result.silenced.includes(f) ? 'silenced' : 'open'
      }
    });
  }
  return {
    verdict: {
      verdict: result.verdict,
      headSha: result.headSha,
      baseSha: result.baseSha,
      rulePackVersion: result.rulePackVersion,
    },
    sarif: {
      $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
      version: '2.1.0',
      runs: [{
        tool: {
          driver: {
            name: 'sentinel',
            version: result.rulePackVersion,
            rules: RULE_IDS.map(id => ({ id, shortDescription: { text: id } }))
          }
        },
        results: sarifResults
      }]
    }
  };
}

export function formatHuman(result) {
  const lines = [];
  lines.push(`HEAD: ${result.headSha}`);
  if (result.blocking.length > 0) {
    lines.push(`DO NOT SHIP — ${result.blocking.length} finding(s)`);
    for (const f of result.blocking) {
      lines.push(`  ${f.file}:${f.line} [${f.ruleId}] ${f.evidence}`);
    }
  } else {
    lines.push(`SHIP — 0 findings`);
  }
  if (result.silenced.length > 0) {
    lines.push(`Silenced (resolved): ${result.silenced.length}`);
    for (const f of result.silenced) {
      lines.push(`  ${f.file}:${f.line} [${f.ruleId}] (silenced)`);
    }
  }
  lines.push(`passed-checks: ${result.checksPassed}`);
  return lines.join('\n');
}

export async function review({ pr, repo: explicitRepo, format, memoryPath }) {
  const repo = resolveRepo(explicitRepo);
  const prData = ghApi(`pulls/${pr}`, repo);
  const headSha = prData.head.sha;
  const baseShaStart = prData.base.sha;

  const diffText = execSync(
    `gh api repos/${repo}/pulls/${pr} -H "Accept: application/vnd.github.v3.diff"`,
    { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  );

  const rules = await loadRules();
  const findings = [];
  for (const check of rules) findings.push(...check(diffText));

  findings.sort((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 :
    a.line - b.line || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)
  );

  const prDataCheck = ghApi(`pulls/${pr}`, repo);
  const fresh = checkFreshness(
    { headSha, baseSha: baseShaStart },
    { headSha: prDataCheck.head.sha, baseSha: prDataCheck.base.sha },
  );
  if (!fresh.fresh) {
    console.log(`STALE — ${fresh.reason}`);
    process.exit(2);
  }

  const resolutions = load(memoryPath);
  const result = computeVerdict(findings, resolutions, {
    headSha,
    baseSha: baseShaStart,
    rulePackVersion: '1.0.0',
  });

  if (format === 'sarif') {
    console.log(JSON.stringify(toSarif(result), null, 2));
  } else {
    console.log(formatHuman(result));
  }

  process.exit(result.verdict === 'SHIP' ? 0 : 1);
}

export function resolveFinding({ ruleId, file, evidence, headSha, reason, memoryPath }) {
  return memAppend({ ruleId, file, evidence, resolvingHeadSha: headSha, reason }, memoryPath);
}
