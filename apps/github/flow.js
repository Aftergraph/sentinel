// Sentinel GitHub webhook end-to-end flow (wiring slice).
//
// handlePullRequest() wires the isolated slices into one path:
//   ingestPR (store.js: SHA validation + repo gate + PR record)
//   → reviewFn (injected pure function — flow never shells out, never
//     imports network/exec; receives { diff, repo, prNumber, headSha,
//     baseSha } and returns { verdict, summary?, findings? } or a verdict
//     string)
//   → postCheck (checks.js: check run + [STALE] supersede).
//
// Ordering is the contract: ingestPR runs BEFORE any api touch, so a
// malformed SHA throws fail-closed with zero api calls, and an unknown
// repo returns { ignored: true } without calling reviewFn or the api.
// Every non-ignored step emits an audit event: pr.ingested /
// verdict-invalidated (store.js), review.computed (here), check.created /
// check.updated / check.superseded (checks.js), all with actor
// `github-app`.
import { append } from '../../lib/audit.js';
import { ingestPR } from './store.js';
import { postCheck } from './checks.js';

const SUPPORTED_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

const STORE_PATH_KEYS = [
  'storePath',
  'prStorePath',
  'prPath',
  'ingestStorePath',
  'ingestPath',
  'checksPath',
  'checksStorePath',
  'checkStorePath',
  'checkPath',
];

// `store` is the path-opts passthrough shared by store.js and checks.js:
// a bare store-file path string, or an opts object ({ storePath,
// checksPath, ... }). Top-level path keys on the input object fill gaps.
function resolveStoreOpts(store, input) {
  let base;
  if (typeof store === 'string') {
    base = { storePath: store };
  } else if (store && typeof store === 'object' && !Array.isArray(store)) {
    base = { ...store };
  } else if (store === undefined || store === null) {
    base = {};
  } else {
    throw new Error('handlePullRequest requires store as a path string or opts object (fail closed)');
  }
  for (const key of STORE_PATH_KEYS) {
    if (base[key] === undefined && input && typeof input[key] === 'string') base[key] = input[key];
  }
  return base;
}

function resolvePrNumber(event) {
  return event.prNumber ?? event.pr ?? event.pullNumber;
}

function normalizeDecision(decided) {
  if (typeof decided === 'string') return { verdict: decided, summary: null, findings: [] };
  if (!decided || typeof decided !== 'object' || Array.isArray(decided)) {
    throw new Error('handlePullRequest: reviewFn must return { verdict, summary?, findings? } (fail closed)');
  }
  const { verdict, summary = null, findings = [] } = decided;
  return { verdict, summary, findings };
}

// Full webhook path for one pull_request delivery. input: { store, api,
// event, reviewFn, diff? }. event: { action, repo, prNumber, headSha,
// baseSha, diff? }. reviewFn is required (caller-supplied pure function).
// Returns { verdict, checkRunId, headSha }, or { ignored: true }.
export async function handlePullRequest(input = {}) {
  const { store, event } = input ?? {};
  const api = input?.api ?? input?.checksApi ?? input?.checkApi;
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('handlePullRequest requires event {action, repo, prNumber, headSha, baseSha} (fail closed)');
  }
  const { action, repo, headSha, baseSha } = event;
  const prNumber = resolvePrNumber(event);
  if (!SUPPORTED_ACTIONS.has(action)) return { ignored: true };

  const storeOpts = resolveStoreOpts(store, input);

  // Ingest first: validates 40-hex SHAs fail-closed BEFORE any api call
  // (throws take precedence over the unknown-repo gate, matching
  // store.js). Unknown repos return { ignored: true } with no audit.
  const ingested = ingestPR({ repo, prNumber, headSha, baseSha }, storeOpts);
  if (ingested && typeof ingested === 'object' && ingested.ignored === true) {
    return { ignored: true };
  }

  const reviewFn = input?.reviewFn ?? input?.review ?? event?.reviewFn;
  if (typeof reviewFn !== 'function') {
    throw new Error('handlePullRequest requires reviewFn({diff, repo, prNumber, headSha, baseSha}) (fail closed)');
  }
  const diff = input?.diff ?? event?.diff ?? event?.diffText ?? '';
  const { verdict, summary, findings } = normalizeDecision(
    await reviewFn({ diff, repo, prNumber, headSha, baseSha }),
  );

  append('review.computed', {
    from: headSha ?? null,
    to: verdict ?? null,
    actor: 'github-app',
    reason: `review:computed:${repo}#${String(prNumber)}:${headSha}:${verdict}`,
  });

  // postCheck validates api/verdict/findings fail-closed before any api
  // call, then creates/updates/supersedes the sentinel/review run.
  const posted = await postCheck(
    { api, repo, prNumber, headSha, verdict, summary, findings },
    storeOpts,
  );
  if (posted && typeof posted === 'object' && posted.ignored === true) {
    return { ignored: true };
  }
  return { verdict, checkRunId: posted.checkRunId, headSha };
}
