// Sentinel GitHub Check-runs integration (zero-dep, no network).
//
// postCheck() transports a lib/ verdict onto a GitHub check run named
// `sentinel/review`. The GitHub client is INJECTED as `{ createCheckRun,
// updateCheckRun }` — this module never imports network; production wiring
// via `gh api` is a follow-up and lives outside this file.
//
// Keying (file-backed JSON registry, default ~/.sentinel/github-checks.json):
//   `${repo}#${prNumber}#${headSha}` (prNumber aliases: pr, pullNumber).
//   - First verdict for a headSha  → createCheckRun (status completed).
//   - Same headSha redelivery       → updateCheckRun (idempotent, no dupes).
//   - New headSha, same repo+PR     → create a NEW run + supersede the old
//     run(s) via updateCheckRun (old conclusion UNCHANGED, title prefixed
//     `[STALE]` — an old verdict is never silently greened).
// Unknown repos return { ignored: true } (no throw, no audit, no api call),
// mirroring ingestPR. Missing api client (or a client without both methods)
// throws fail-closed. Every create/update/supersede appends one audit event
// via ../../lib/audit.js with actor `github-app`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { append } from '../../lib/audit.js';
import { loadStore as loadInstallStore } from './store.js';

export const CHECK_NAME = 'sentinel/review';

// SHIP → success, DO_NOT_SHIP/BLOCKED → failure (both block merge),
// STALE → neutral (no verdict on a superseded commit, never failure).
export const CONCLUSIONS = {
  SHIP: 'success',
  DO_NOT_SHIP: 'failure',
  BLOCKED: 'failure',
  STALE: 'neutral',
};

const VALID_VERDICTS = Object.keys(CONCLUSIONS);
const HEX40 = /^[0-9a-f]{40}$/i;
const TOP_FINDINGS = 10;

export function conclusionFor(verdict) {
  const conclusion = CONCLUSIONS[verdict];
  if (!conclusion) {
    throw new Error(`postCheck requires verdict ${VALID_VERDICTS.join('|')} (got ${String(verdict)})`);
  }
  return conclusion;
}

export function defaultChecksPath() {
  return join(homedir(), '.sentinel', 'github-checks.json');
}

export function loadChecks(path = defaultChecksPath()) {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
  } catch {
    return {};
  }
}

export function saveChecks(store, path = defaultChecksPath()) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) {
    throw new Error('saveChecks requires a store object');
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + '\n');
  return store;
}

// Checks-file resolution: an explicit checks path wins; otherwise a
// storePath-derived sibling keeps one tmp dir isolating every registry
// (same convention as the PR store in store.js).
function resolveChecksPath(opts) {
  if (opts && typeof opts === 'object') {
    const p = opts.checksPath ?? opts.checksStorePath ?? opts.checkStorePath ?? opts.checkPath;
    if (typeof p === 'string') return p;
    if (typeof opts.storePath === 'string') return join(dirname(opts.storePath), 'github-checks.json');
  }
  return defaultChecksPath();
}

function resolveInstallPath(opts) {
  if (typeof opts === 'string') return opts;
  if (opts && typeof opts === 'object' && typeof opts.storePath === 'string') return opts.storePath;
  return undefined; // loadInstallStore() falls back to its own default
}

function isRepoKnown(repo, opts) {
  const installPath = resolveInstallPath(opts);
  const store = installPath === undefined ? loadInstallStore() : loadInstallStore(installPath);
  return Object.values(store).some(
    (r) => r && typeof r === 'object' && Array.isArray(r.repos) && r.repos.includes(repo),
  );
}

function checkKey(repo, prNumber, headSha) {
  return prNumber === null ? `${repo}#${headSha}` : `${repo}#${String(prNumber)}#${headSha}`;
}

function prPrefix(repo, prNumber) {
  return `${repo}#${String(prNumber)}#`;
}

function safeEvidence(text) {
  return String(text || '').replace(/`+/g, "'").replace(/\s+/g, ' ').slice(0, 300);
}

function requireFinding(f, i) {
  if (!f || typeof f !== 'object') throw new Error(`postCheck requires findings[${i}] to carry ruleId+file+line`);
  if (typeof f.ruleId !== 'string' || f.ruleId.trim() === '') {
    throw new Error(`postCheck requires findings[${i}].ruleId`);
  }
  if (typeof f.file !== 'string' || f.file.trim() === '') {
    throw new Error(`postCheck requires findings[${i}].file`);
  }
  if (typeof f.line !== 'number' || !Number.isFinite(f.line)) {
    throw new Error(`postCheck requires findings[${i}].line`);
  }
  return f;
}

function renderSummary(summary) {
  if (!summary) return '';
  if (typeof summary === 'string') return summary;
  if (typeof summary === 'object' && (summary.files !== undefined || summary.added !== undefined)) {
    return `Diff: ${summary.files ?? '?'} file(s), +${summary.added ?? 0}/-${summary.removed ?? 0}`;
  }
  return '';
}

// Output carries the verdict, the EXACT head SHA (never shortened — the
// check binds to the commit it verified), and the top findings.
function buildOutput({ verdict, headSha, summary, findings }) {
  const title = `Sentinel verdict: ${verdict}`;
  const headLine = `Verdict ${verdict} on exact HEAD ${headSha}.`;
  const extra = renderSummary(summary);
  const countLine = findings.length === 0
    ? 'No blocking findings on the verified HEAD.'
    : `${findings.length} blocking finding(s):`;
  const summaryText = [headLine, extra, countLine].filter(Boolean).join('\n');
  let text;
  if (findings.length === 0) {
    text = `HEAD ${headSha} verified with no blocking findings.`;
  } else {
    const shown = findings.slice(0, TOP_FINDINGS);
    const lines = shown.map((f) => `- [${f.ruleId}] \`${f.file}:${f.line}\`${f.evidence ? ` ${safeEvidence(f.evidence)}` : ''}`);
    if (findings.length > shown.length) lines.push(`…and ${findings.length - shown.length} more`);
    lines.push(`\nFull HEAD: ${headSha}`);
    text = lines.join('\n');
  }
  return { title, summary: summaryText, text };
}

function checkRunId(res) {
  if (typeof res === 'number' && Number.isFinite(res)) return res;
  if (res && typeof res === 'object') {
    const id = res.id ?? res.check_run_id ?? res.checkRunId;
    if (id !== undefined && id !== null && id !== '') return id;
  }
  throw new Error('postCheck: createCheckRun returned no check-run id (fail closed)');
}

// Post (or refresh) the sentinel/review check run for one exact HEAD.
// input: { api, repo, prNumber|pr|pullNumber, headSha, verdict, summary?, findings? }
// opts: store/checks path overrides (see resolveChecksPath).
export async function postCheck(input, opts) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('postCheck requires {api, repo, headSha, verdict}');
  }
  const api = input.api ?? (opts && typeof opts === 'object' ? opts.api : undefined);
  if (!api || typeof api !== 'object') {
    throw new Error('postCheck requires api client { createCheckRun, updateCheckRun } (fail closed)');
  }
  if (typeof api.createCheckRun !== 'function' || typeof api.updateCheckRun !== 'function') {
    throw new Error('postCheck requires api client { createCheckRun, updateCheckRun } (fail closed)');
  }
  const { repo, headSha, verdict } = input;
  if (typeof repo !== 'string' || repo.trim() === '') throw new Error('postCheck requires repo');
  if (typeof headSha !== 'string' || !HEX40.test(headSha)) {
    throw new Error('postCheck requires 40-hex headSha');
  }
  const conclusion = conclusionFor(verdict);
  const prNumber = input.prNumber ?? input.pr ?? input.pullNumber ?? null;
  if (prNumber !== null && (typeof prNumber !== 'number' && typeof prNumber !== 'string' || String(prNumber).trim() === '')) {
    throw new Error('postCheck requires prNumber when given to be a number or string');
  }
  const summary = input.summary ?? null;
  const findings = input.findings === undefined ? [] : input.findings;
  if (!Array.isArray(findings)) throw new Error('postCheck requires findings to be an array');
  findings.forEach(requireFinding);

  if (!isRepoKnown(repo, opts)) return { ignored: true };

  const checksPath = resolveChecksPath(opts);
  const store = loadChecks(checksPath);
  const key = checkKey(repo, prNumber, headSha);
  const output = buildOutput({ verdict, headSha, summary, findings });

  // Same-headSha redelivery: refresh the existing run in place.
  const prev = store[key] || null;
  if (prev && prev.checkRunId !== undefined && prev.checkRunId !== null) {
    await api.updateCheckRun(prev.checkRunId, {
      name: CHECK_NAME,
      head_sha: headSha,
      status: 'completed',
      conclusion,
      output,
    });
    store[key] = { ...prev, repo, prNumber, headSha, verdict, conclusion, title: output.title, updatedAt: new Date().toISOString() };
    saveChecks(store, checksPath);
    append('check.updated', {
      from: String(prev.checkRunId),
      to: headSha,
      actor: 'github-app',
      reason: `check:updated:${repo}#${prNumber === null ? '' : String(prNumber)}:${headSha}:${verdict}`,
    });
    return { action: 'updated', checkRunId: prev.checkRunId, conclusion };
  }

  // New headSha for a known repo+PR: supersede older runs first so the old
  // verdict can never read as current. Old conclusion is passed through
  // UNCHANGED; only the title gains the [STALE] prefix.
  const superseded = [];
  if (prNumber !== null) {
    const prefix = prPrefix(repo, prNumber);
    for (const [k, rec] of Object.entries(store)) {
      if (!k.startsWith(prefix) || k === key || !rec || rec.superseded) continue;
      if (rec.checkRunId === undefined || rec.checkRunId === null) continue;
      const staleTitle = rec.title && !rec.title.startsWith('[STALE]') ? `[STALE] ${rec.title}` : (rec.title || `[STALE] Sentinel verdict: ${rec.verdict || 'unknown'}`);
      await api.updateCheckRun(rec.checkRunId, {
        status: 'completed',
        conclusion: rec.conclusion,
        output: {
          title: staleTitle,
          summary: `Superseded: HEAD moved to ${headSha}. This verdict no longer applies.`,
          text: `Superseded by HEAD ${headSha}. Original verdict ${rec.verdict || '?'} on ${rec.headSha || '?'}.`,
        },
      });
      store[k] = { ...rec, title: staleTitle, superseded: true, updatedAt: new Date().toISOString() };
      superseded.push(rec.checkRunId);
      append('check.superseded', {
        from: rec.headSha || null,
        to: headSha,
        actor: 'github-app',
        reason: `check:superseded:${repo}#${String(prNumber)}:${rec.headSha || '?'}->${headSha}`,
      });
    }
  }

  const created = await api.createCheckRun({
    name: CHECK_NAME,
    head_sha: headSha,
    status: 'completed',
    conclusion,
    output,
  });
  const id = checkRunId(created);
  store[key] = {
    repo, prNumber, headSha, verdict, conclusion,
    checkRunId: id, title: output.title,
    superseded: false,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  saveChecks(store, checksPath);
  append('check.created', {
    from: null,
    to: headSha,
    actor: 'github-app',
    reason: `check:created:${repo}#${prNumber === null ? '' : String(prNumber)}:${headSha}:${verdict}:${String(id)}`,
  });
  return { action: 'created', checkRunId: id, conclusion, superseded };
}
