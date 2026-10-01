// Sentinel GitHub App economic-evidence workflow aggregator.
// Aggregates exact-HEAD GitHub Actions evidence into one App-owned check.
// It does not rerun verifiers and grants no merge/execution authority.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const ECONOMIC_CHECK_NAME = 'sentinel/economic-evidence';

const PATH_WORKFLOWS = [
  ['lib/economic-evidence-pack.js', 'Economic Evidence Pack'],
  ['test/economic-evidence-pack.test.mjs', 'Economic Evidence Pack'],
  ['.github/workflows/economic-evidence-pack.yml', 'Economic Evidence Pack'],
  ['lib/economic-evidence-campaign.js', 'Economic Evidence Campaign'],
  ['test/economic-evidence-campaign.test.mjs', 'Economic Evidence Campaign'],
  ['.github/workflows/economic-evidence-campaign.yml', 'Economic Evidence Campaign'],
  ['lib/economic-source-capture.js', 'Economic Source Capture'],
  ['test/economic-source-capture.test.mjs', 'Economic Source Capture'],
  ['.github/workflows/economic-source-capture.yml', 'Economic Source Capture'],
  ['lib/economic-source-generation-ledger.js', 'Economic Source Generation Ledger'],
  ['test/economic-source-generation-ledger.test.mjs', 'Economic Source Generation Ledger'],
  ['.github/workflows/economic-source-generation-ledger.yml', 'Economic Source Generation Ledger'],
];

function changedPaths(diffText) {
  const paths = new Set();
  for (const line of String(diffText || '').split('\n')) {
    if (!line.startsWith('diff --git a/')) continue;
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (m) paths.add(m[2]);
  }
  return [...paths];
}

export function requiredEconomicWorkflows(diffText) {
  const paths = changedPaths(diffText);
  const economic = paths.some((p) =>
    p.startsWith('lib/economic-') ||
    p.startsWith('test/economic-') ||
    p.startsWith('.github/workflows/economic-') ||
    /^docs\/evidence\/economic-campaigns\/[^/]+\/evidence-pack\.json$/.test(p)
  );
  if (!economic) return [];
  const required = new Set(['test']);
  for (const path of paths) {
    for (const [watched, workflow] of PATH_WORKFLOWS) {
      if (path === watched) required.add(workflow);
    }
  }
  return [...required].sort();
}

function latestByWorkflow(workflowRuns, headSha) {
  const latest = new Map();
  for (const run of workflowRuns || []) {
    if (!run || run.head_sha !== headSha || typeof run.name !== 'string') continue;
    const prior = latest.get(run.name);
    const priorTime = Date.parse(prior?.updated_at || prior?.created_at || 0);
    const nextTime = Date.parse(run.updated_at || run.created_at || 0);
    if (!prior || nextTime >= priorTime) latest.set(run.name, run);
  }
  return latest;
}

export function aggregateEconomicWorkflowRuns({ required, workflowRuns, headSha }) {
  const latest = latestByWorkflow(workflowRuns, headSha);
  const rows = [];
  let failed = false;
  let pending = false;

  for (const name of required) {
    const run = latest.get(name);
    if (!run) {
      rows.push({ name, state: 'missing', conclusion: null, runId: null });
      pending = true;
      continue;
    }
    if (run.status !== 'completed') {
      rows.push({ name, state: run.status || 'pending', conclusion: run.conclusion ?? null, runId: run.id ?? null });
      pending = true;
      continue;
    }
    const ok = run.conclusion === 'success';
    rows.push({ name, state: 'completed', conclusion: run.conclusion ?? null, runId: run.id ?? null });
    if (!ok) failed = true;
  }

  return {
    ready: !pending,
    success: !pending && !failed,
    failed,
    rows,
  };
}

export function defaultEconomicChecksPath() {
  return join(homedir(), '.sentinel', 'github-economic-checks.json');
}

function resolvePath(opts = {}) {
  if (typeof opts.economicChecksPath === 'string') return opts.economicChecksPath;
  if (typeof opts.storePath === 'string') return join(dirname(opts.storePath), 'github-economic-checks.json');
  return defaultEconomicChecksPath();
}

function loadStore(path) {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function saveStore(path, store) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n');
}

function key(repo, prNumber, headSha) {
  return repo + '#' + String(prNumber) + '#' + headSha;
}

function outputFor(headSha, aggregate, evidenceVerification = null) {
  const lines = aggregate.rows.map((row) =>
    '- ' + row.name + ': ' + (row.conclusion ?? row.state) + (row.runId ? ' (run ' + row.runId + ')' : '')
  );
  if (evidenceVerification) {
    lines.push('- Evidence envelope: ' + evidenceVerification.state);
    if (evidenceVerification.path) lines.push('- Evidence path: ' + evidenceVerification.path);
    for (const reason of evidenceVerification.reasons || []) lines.push('- Evidence reason: ' + reason);
  }

  const evidenceInvalid = evidenceVerification && !evidenceVerification.valid;
  const verifiedPack = aggregate.success && evidenceVerification?.valid === true;
  const workflowsOnly = aggregate.success && !evidenceVerification;

  const title = verifiedPack
    ? 'Economic evidence: VERIFIED_EVIDENCE_PACK'
    : workflowsOnly
      ? 'Economic verifier workflows: PASS'
      : 'Economic evidence: BLOCKED';
  const summary = verifiedPack
    ? 'Exact-HEAD workflows passed and Sentinel independently verified the repository/head-bound EvidencePack.'
    : workflowsOnly
      ? 'All required economic verifier workflows passed on exact HEAD. No EvidencePack attestation was present in this PR.'
      : evidenceInvalid
        ? 'Verifier workflows passed, but the exact-HEAD EvidencePack envelope failed Sentinel verification.'
        : 'One or more required economic verifier workflows failed on exact HEAD ' + headSha + '.';
  return { title, summary, text: lines.join('\n') + '\n\nExact HEAD: ' + headSha };
}

export async function postEconomicEvidenceCheck({
  api, repo, prNumber, headSha, aggregate, evidenceVerification = null, opts = {},
}) {
  if (!api || typeof api.createCheckRun !== 'function' || typeof api.updateCheckRun !== 'function') {
    throw new Error('economic evidence check requires check-run api (fail closed)');
  }
  if (!aggregate?.ready) {
    return { posted: false, pending: true, rows: aggregate?.rows || [] };
  }

  const path = resolvePath(opts);
  const store = loadStore(path);
  const k = key(repo, prNumber, headSha);
  const params = {
    repo,
    name: ECONOMIC_CHECK_NAME,
    head_sha: headSha,
    status: 'completed',
    conclusion: aggregate.success && (!evidenceVerification || evidenceVerification.valid) ? 'success' : 'failure',
    output: outputFor(headSha, aggregate, evidenceVerification),
  };

  let id = store[k]?.id;
  let response;
  if (id) {
    response = await api.updateCheckRun(id, params);
  } else {
    response = await api.createCheckRun(params);
    id = response?.id ?? response?.check_run_id ?? response?.checkRunId;
    if (id === undefined || id === null || id === '') {
      throw new Error('economic evidence check create returned no id (fail closed)');
    }
  }

  store[k] = {
    id,
    conclusion: params.conclusion,
    evidenceState: evidenceVerification?.state ?? 'WORKFLOWS_VERIFIED',
    headSha,
    updatedAt: new Date().toISOString(),
  };
  saveStore(path, store);
  return { posted: true, pending: false, id, conclusion: params.conclusion };
}
