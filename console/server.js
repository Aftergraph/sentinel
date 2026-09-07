// Sentinel Console API server — Team 1.
//
// Same-origin JSON API over lib/ verdicts (the console presents, lib/
// decides — console-v1-design §2). Zero runtime dependencies; the handler
// returned by createConsoleServer plugs straight into node:http
// createServer. Spec: docs/console-v1-design.md §4 (contract table).

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  analyzeDiff,
  checkFreshness,
  computeDelta,
  loadConfig,
  environmentInfo,
  localHeadSha,
  resolveFinding,
  toJson,
} from '../lib/review.js';
import {
  makeReceipt,
  appendLedger,
  loadLedger,
  latestForRepoPr,
  verifyReceipt,
  detectSource,
} from '../lib/receipt.js';
import { load as loadMemory } from '../lib/memory.js';
import { planChecks, completeRun } from '../lib/verify.js';
import {
  RULE_PACK_VERSION,
  SUPPORTED_PACKS,
  SEVERITY_MAP,
  BLOCKING_SEVERITIES,
  ruleIdsForPack,
} from '../lib/rulepack.js';
import { createOrgStore } from '../lib/org-store.js';
import { createEvidenceStore } from '../lib/evidence-store.js';
import { sealEvidence, hashBody } from '../lib/evidence.js';
import { createFinding } from '../lib/finding.js';

const MAX_BODY = 1024 * 1024;

let VERSION = '0.0.0';
try {
  VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || VERSION;
} catch { /* keep default */ }

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Abuse hardening: fixed-window per-IP rate limiter for /api/*
// (token-bucket with full refill per window). Keyed by
// req.socket.remoteAddress ONLY — no headers (X-Forwarded-For etc.) are
// honored, so bucket state can never leak cross-IP via spoofed headers.
// Memory is bounded: expired buckets are swept on every check, so only
// IPs seen in the current window are retained. Counters reset per
// window. Exported for direct unit testing (per-IP isolation).
export function createRateLimiter({ windowMs = 60000, max = 300 } = {}) {
  const w = Number(windowMs);
  const m = Number(max);
  const windowMsNorm = Number.isFinite(w) && w > 0 ? w : 60000;
  const maxNorm = Number.isFinite(m) && m > 0 ? Math.floor(m) : 300;
  const buckets = new Map(); // ip -> { count, windowStart }
  function check(ip, now = Date.now()) {
    const key = typeof ip === 'string' && ip ? ip : 'unknown';
    for (const [k, b] of buckets) {
      if (now - b.windowStart >= windowMsNorm) buckets.delete(k);
    }
    let b = buckets.get(key);
    if (!b) {
      b = { count: 0, windowStart: now };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > maxNorm) {
      const retryAfter = Math.max(1, Math.ceil((b.windowStart + windowMsNorm - now) / 1000));
      return { limited: true, retryAfter };
    }
    return { limited: false, retryAfter: 0 };
  }
  return { check, get size() { return buckets.size; } };
}

function isLoopbackIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// Fixed 429 body — never echoes request content (no path, query, or
// body bytes are reflected).
const RATE_LIMITED_BODY = JSON.stringify({ error: 'rate limited' });

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BODY) {
        failed = true;
        reject(new HttpError(413, 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => {
      if (!failed) reject(new HttpError(400, 'unreadable body'));
    });
  });
}

async function readJson(req) {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) {
    throw new HttpError(415, 'content-type must be application/json');
  }
  const raw = await readBody(req);
  if (!raw.trim()) throw new HttpError(400, 'empty body');
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'malformed JSON');
  }
}

function readJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`sentinel console: warn: cannot load ${label} (${path}): ${err.message}; continuing without it`);
    return null;
  }
}

function topoRepoName(entry) {
  if (typeof entry === 'string') return entry.trim() || null;
  if (entry && typeof entry === 'object') {
    for (const k of ['repo', 'name', 'full_name', 'fullName']) {
      if (typeof entry[k] === 'string' && entry[k].trim()) return entry[k].trim();
    }
  }
  return null;
}

function entryHeadSha(entry) {
  if (entry && typeof entry === 'object') {
    for (const k of ['headSha', 'head_sha', 'sha', 'head', 'commit']) {
      if (typeof entry[k] === 'string' && entry[k].trim()) return entry[k].trim();
    }
  }
  return null;
}

// Tolerant reader for generated governance files (display only — the
// console never writes or verifies them; design §6). Accepts a bare
// array, or an object with a repos/projects/state array, or a
// name->sha (or name->entry) map under repos. Returns [{repo, headSha?}].
function listNamedEntries(doc) {
  const found = [];
  const push = (entry) => {
    const repo = topoRepoName(entry);
    if (repo) found.push({ repo, headSha: entryHeadSha(entry) || undefined });
  };
  if (!doc) return found;
  if (Array.isArray(doc)) {
    doc.forEach(push);
    return found;
  }
  if (typeof doc === 'object') {
    for (const k of ['repos', 'projects', 'state']) {
      const v = doc[k];
      if (Array.isArray(v)) {
        v.forEach(push);
        return found;
      }
      if (v && typeof v === 'object') {
        for (const [name, val] of Object.entries(v)) {
          if (typeof val === 'string' && val.trim()) found.push({ repo: name, headSha: val.trim() });
          else push(typeof val === 'object' && val !== null ? { repo: name, ...val } : name);
        }
        return found;
      }
    }
  }
  return found;
}

export function createConsoleServer(opts = {}) {
  const { ledgerPath, memoryPath, configPath, token, repos, platform, noLedger, topologyPath, orgStatePath, orgStorePath, evidenceStorePath, rateLimit, noExemptLoopback } = opts;
  // Rate limiting (abuse hardening, additive): per-IP token-bucket on
  // /api/* except /api/healthz. Default { windowMs: 60000, max: 300 }.
  // Loopback (127.0.0.1/::1) is exempt BY DEFAULT; pass
  // noExemptLoopback: true to disable the exemption (tests).
  const rlOpts = rateLimit && typeof rateLimit === 'object' ? rateLimit : {};
  const limiter = createRateLimiter({
    windowMs: rlOpts.windowMs ?? 60000,
    max: rlOpts.max ?? 300,
  });
  const exemptLoopback = !noExemptLoopback;
  // v1b mode only when governance files are pointed at; otherwise the
  // v1a /api/repos shape is returned byte-identically (no headSource).
  const orgWide = Boolean(topologyPath || orgStatePath);

  function activePack() {
    try {
      return loadConfig(configPath).config.rulePack || RULE_PACK_VERSION;
    } catch (err) {
      throw new HttpError(500, err.message);
    }
  }

  function listRepos() {
    const chain = noLedger ? [] : loadLedger(ledgerPath);
    const latest = new Map();
    for (const r of chain) {
      if (r && typeof r.repo === 'string') latest.set(r.repo, r);
    }
    if (!orgWide) {
      const out = [];
      const seen = new Set();
      const push = (repo) => {
        if (!repo || seen.has(repo)) return;
        seen.add(repo);
        const rec = latest.get(repo);
        out.push(rec
          ? { repo, headSha: rec.headSha, lastVerdict: rec.verdict, receiptId: rec.receipt_id }
          : { repo });
      };
      for (const entry of repos || []) push(typeof entry === 'string' ? entry : entry && entry.repo);
      for (const repo of latest.keys()) push(repo);
      return out;
    }
    // v1b: union flag repos + topology repos + ledger repos; exact HEAD
    // per repo comes from org-state when matched by repo name (display
    // generated truth, never generate it — design §6).
    const topoDoc = topologyPath ? readJsonFile(topologyPath, 'topology') : null;
    const orgDoc = orgStatePath ? readJsonFile(orgStatePath, 'org-state') : null;
    const topoEntries = listNamedEntries(topoDoc);
    const orgHeads = new Map();
    for (const e of listNamedEntries(orgDoc)) {
      if (e.headSha && !orgHeads.has(e.repo)) orgHeads.set(e.repo, e.headSha);
    }
    const topoHeads = new Map();
    for (const e of topoEntries) {
      if (e.headSha && !topoHeads.has(e.repo)) topoHeads.set(e.repo, e.headSha);
    }
    const out = [];
    const seen = new Set();
    const push = (repo, fallbackSource) => {
      if (!repo || seen.has(repo)) return;
      seen.add(repo);
      const rec = latest.get(repo);
      const row = { repo };
      if (orgHeads.has(repo)) {
        row.headSha = orgHeads.get(repo);
        row.headSource = 'org-state';
      } else if (rec && rec.headSha) {
        row.headSha = rec.headSha;
        row.headSource = 'ledger';
      } else if (topoHeads.has(repo)) {
        row.headSha = topoHeads.get(repo);
        row.headSource = 'topology';
      } else {
        row.headSource = fallbackSource;
      }
      if (rec) {
        row.lastVerdict = rec.verdict;
        row.receiptId = rec.receipt_id;
      }
      out.push(row);
    };
    for (const entry of repos || []) push(typeof entry === 'string' ? entry : entry && entry.repo, 'flag');
    for (const e of topoEntries) push(e.repo, 'topology');
    for (const repo of latest.keys()) push(repo, 'ledger');
    return out;
  }

  // Org scoping (display only — resolved from the org-store file pointed
  // at by orgStorePath; the console never mutates org state and emits no
  // audit events for scoped reads). Without orgStorePath every org input
  // is ignored and the v1a/v1b shapes are returned byte-identically. The
  // store file is re-read per scoped request so seeds written before or
  // after boot are both visible.
  const orgStorePathSet = typeof orgStorePath === 'string' && orgStorePath.trim() !== '';

  function isWellFormedOrgId(id) {
    return typeof id === 'string' && /^org_[A-Za-z0-9_-]+$/.test(id);
  }

  function loadOrgStore() {
    try {
      return createOrgStore(orgStorePath);
    } catch (err) {
      throw new HttpError(500, err.message);
    }
  }

  // Rows for one org: linked fullNames enriched with the same
  // head/verdict data as listRepos(). Linked-but-never-reviewed repos
  // still appear as bare { repo } rows.
  function orgRepoRows(store, orgId) {
    const names = [];
    const seen = new Set();
    for (const r of store.reposForOrg(orgId)) {
      const name = r && typeof r.fullName === 'string' ? r.fullName : null;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    const byName = new Map();
    for (const row of listRepos()) {
      if (row && typeof row.repo === 'string' && !byName.has(row.repo)) byName.set(row.repo, row);
    }
    return names.map((name) => byName.get(name) || { repo: name });
  }

  // Shared ?org= handling for /api/repos and /api/overview. Returns null
  // when unscoped (no param, or no store configured — legacy behavior).
  // Throws 400 on malformed or unknown ids (query scope never 404s, so
  // org existence cannot be confused with a missing route).
  function resolveOrgQuery(orgParam) {
    if (orgParam === null || !orgStorePathSet) return null;
    if (!isWellFormedOrgId(orgParam)) throw new HttpError(400, 'malformed org id');
    const store = loadOrgStore();
    if (!store.getOrg(orgParam)) throw new HttpError(400, 'unknown org');
    return { store, rows: orgRepoRows(store, orgParam) };
  }

  function finishReview({ repo, prNumber, headSha, baseSha, pack, configHash, result, summary }) {
    const chain = noLedger ? [] : loadLedger(ledgerPath);
    const prev = noLedger ? null : latestForRepoPr(chain, repo, prNumber);
    const prevHeadSha = prev && prev.headSha !== headSha ? prev.headSha : null;
    const delta = prevHeadSha
      ? { prevHeadSha, ...computeDelta((prev.findings || {}).blocking, result.blocking) }
      : null;
    const snapshot = {
      blocking: result.blocking,
      silenced: result.silenced,
      nonBlocking: result.nonBlocking || [],
      excluded: result.excluded || [],
    };
    const receipt = makeReceipt({
      repo,
      prNumber,
      headSha,
      baseSha,
      rulePackVersion: pack,
      verdict: result.verdict,
      findings: snapshot,
      counts: {
        blocking: snapshot.blocking.length,
        silenced: snapshot.silenced.length,
        nonBlocking: snapshot.nonBlocking.length,
        excluded: snapshot.excluded.length,
      },
      configHash,
      source: detectSource(),
      environment: environmentInfo(),
      prevReceiptId: prev ? prev.receipt_id : null,
    });
    if (!noLedger) appendLedger(receipt, ledgerPath);
    const json = toJson(result, { repo, prNumber, summary, delta, receipt });
    return {
      verdict: result.verdict,
      findings: json.findings,
      summary: json.summary,
      delta: json.delta,
      receipt: json.receipt,
      review: json.review,
      checksPassed: json.checksPassed,
    };
  }

  async function runReview(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'invalid JSON body');
    }
    let cfg;
    try {
      cfg = loadConfig(configPath);
    } catch (err) {
      throw new HttpError(500, err.message);
    }
    const pack = cfg.config.rulePack || RULE_PACK_VERSION;
    const excludePatterns = cfg.config.exclude || [];
    const configHash = cfg.configHash;
    const resolutions = loadMemory(memoryPath);

    const useDiff = typeof body.diff === 'string' && body.diff.length > 0;
    const wantPr = typeof body.repo === 'string' && !!body.repo && body.pr !== undefined && body.pr !== null && String(body.pr) !== '';
    if (!useDiff && !wantPr) throw new HttpError(400, 'provide diff or repo+pr');

    if (useDiff) {
      const diffText = body.diff;
      const repo = body.repo || `local/${process.cwd().split(/[\\/]/).pop()}`;
      const prNumber = body.pr ?? null;
      const headSha = body.headSha || localHeadSha(diffText);
      const baseSha = body.baseSha || 'local-base';
      const { result, summary } = await analyzeDiff({
        diffText, pack, excludePatterns, resolutions, headSha, baseSha,
      });
      return finishReview({ repo, prNumber, headSha, baseSha, pack, configHash, result, summary });
    }

    // PR mode: platform supplies the diff; freshness is re-checked after
    // analysis (same rule as the GitHub App slice in apps/github/app.js).
    if (!platform || typeof platform.getPR !== 'function' || typeof platform.getDiff !== 'function') {
      throw new HttpError(502, 'no platform configured');
    }
    const repo = body.repo;
    const prNumber = body.pr;
    let prData;
    try {
      prData = await platform.getPR(repo, prNumber);
    } catch (err) {
      throw new HttpError(502, `platform getPR failed: ${err.message}`);
    }
    const headSha = prData.head.sha;
    const baseSha = prData.base.sha;
    let rawDiff;
    try {
      rawDiff = await platform.getDiff(repo, prNumber);
    } catch (err) {
      throw new HttpError(502, `platform getDiff failed: ${err.message}`);
    }
    const diffText = typeof rawDiff === 'string' ? rawDiff : String(rawDiff);
    const { result, summary } = await analyzeDiff({
      diffText, pack, excludePatterns, resolutions, headSha, baseSha,
    });
    let check;
    try {
      check = await platform.getPR(repo, prNumber);
    } catch (err) {
      throw new HttpError(502, `platform re-check failed: ${err.message}`);
    }
    const fresh = checkFreshness(
      { headSha, baseSha },
      { headSha: check.head.sha, baseSha: check.base.sha },
    );
    if (!fresh.fresh) {
      const staleResult = {
        verdict: 'STALE',
        headSha,
        baseSha,
        rulePackVersion: pack,
        blocking: [],
        silenced: [],
        nonBlocking: [],
        excluded: [],
        checksPassed: ruleIdsForPack(pack).length,
      };
      return {
        ...finishReview({ repo, prNumber, headSha, baseSha, pack, configHash, result: staleResult, summary }),
        staleReason: fresh.reason,
      };
    }
    return finishReview({ repo, prNumber, headSha, baseSha, pack, configHash, result, summary });
  }

  function runResolve(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'invalid JSON body');
    }
    if (typeof body.reason !== 'string' || body.reason.trim() === '') {
      throw new HttpError(400, 'reason is required');
    }
    if (typeof body.ruleId !== 'string' || !body.ruleId || typeof body.file !== 'string' || !body.file) {
      throw new HttpError(400, 'ruleId and file are required');
    }
    return resolveFinding({
      ruleId: body.ruleId,
      file: body.file,
      evidence: body.evidence ?? '',
      headSha: body.headSha ?? null,
      reason: body.reason,
      memoryPath,
    });
  }

  function runVerify(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !body.receipt || typeof body.receipt !== 'object') {
      throw new HttpError(400, 'missing receipt');
    }
    const out = verifyReceipt(body.receipt);
    return out.valid ? { valid: true } : { valid: false, reason: out.reason };
  }

  // Overview roll-up (display only — derived from the same ledger +
  // topology fixtures as /api/repos; no new persistence — design §6).
  // open = tracked repos; blocked/stale = latest-verdict counts;
  // critical = outstanding blocking findings across latest receipts;
  // confidence = SHIP share of repos with a verdict (1 when none yet).
  function buildOverview(scopedRows = null) {
    const repos = scopedRows || listRepos();
    const scopedSet = scopedRows ? new Set(scopedRows.map((r) => r.repo)) : null;
    const chain = noLedger ? [] : loadLedger(ledgerPath);
    const latest = new Map();
    for (const r of chain) {
      if (r && typeof r.repo === 'string') latest.set(r.repo, r);
    }
    let blocked = 0;
    let stale = 0;
    let critical = 0;
    let shipped = 0;
    let withVerdict = 0;
    const needsAttention = [];
    for (const row of repos) {
      const rec = latest.get(row.repo);
      const verdict = rec ? rec.verdict : null;
      const headSha = (rec && rec.headSha) || row.headSha || null;
      const receiptId = (rec && rec.receipt_id) || row.receiptId || null;
      if (verdict === 'DO_NOT_SHIP') {
        blocked += 1;
        withVerdict += 1;
        const n = rec && rec.counts && typeof rec.counts.blocking === 'number'
          ? rec.counts.blocking
          : (rec && rec.findings && Array.isArray(rec.findings.blocking) ? rec.findings.blocking.length : 0);
        critical += n;
        needsAttention.push({ repo: row.repo, reason: 'blocked', verdict, headSha, receiptId });
      } else if (verdict === 'STALE') {
        stale += 1;
        withVerdict += 1;
        needsAttention.push({ repo: row.repo, reason: 'stale', verdict, headSha, receiptId });
      } else if (verdict === 'SHIP') {
        shipped += 1;
        withVerdict += 1;
      } else {
        needsAttention.push({ repo: row.repo, reason: 'no-verdict', verdict: null, headSha: row.headSha || null, receiptId: null });
      }
    }
    needsAttention.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
    const recentVerdicts = chain.filter((r) => !scopedSet || (r && scopedSet.has(r.repo))).slice(-10).reverse().map((r) => ({
      repo: r.repo,
      prNumber: r.prNumber ?? null,
      verdict: r.verdict,
      headSha: r.headSha,
      receiptId: r.receipt_id,
      timestamp: r.timestamp,
    }));
    const confidence = withVerdict === 0 ? 1 : Math.round((shipped / withVerdict) * 100) / 100;
    return { confidence, open: repos.length, blocked, stale, critical, needsAttention, recentVerdicts };
  }

  // Verification-health roll-up (display only — derived server-side from
  // the ledger; the only accepted user input is the standard repo/pr
  // query filters, validated below. Never throws: malformed receipts are
  // skipped and a missing/empty ledger yields all zeros.)
  function parseOptionalRepoPr(url) {
    const repoRaw = url.searchParams.get('repo');
    const prRaw = url.searchParams.get('pr');
    let repo = null;
    let pr = null;
    if (repoRaw !== null) {
      if (typeof repoRaw !== 'string' || repoRaw.trim() === '') {
        throw new HttpError(400, 'invalid repo filter');
      }
      repo = repoRaw;
    }
    if (prRaw !== null) {
      if (typeof prRaw !== 'string' || prRaw.trim() === '' || !/^-?\d+$/.test(prRaw.trim())) {
        throw new HttpError(400, 'invalid pr filter');
      }
      pr = prRaw.trim();
    }
    return { repo, pr };
  }

  function buildHealthVerdicts(filter) {
    let chain = [];
    try {
      chain = noLedger ? [] : loadLedger(ledgerPath);
    } catch {
      chain = [];
    }
    if (!Array.isArray(chain)) chain = [];
    const f = filter || { repo: null, pr: null };
    const totals = { SHIP: 0, DO_NOT_SHIP: 0, STALE: 0, BLOCKED: 0, OVERRIDDEN: 0 };
    const ruleCounts = new Map();
    let policyOverrides = 0;
    let since = null;
    let sinceTime = Infinity;
    let receipts = 0;
    for (const r of chain) {
      if (!r || typeof r !== 'object') continue;
      if (f.repo !== null && r.repo !== f.repo) continue;
      if (f.pr !== null && String(r.prNumber) !== String(f.pr)) continue;
      receipts += 1;
      try {
        if (typeof r.verdict === 'string' && Object.prototype.hasOwnProperty.call(totals, r.verdict)) {
          totals[r.verdict] += 1;
        }
      } catch { /* never throws */ }
      try {
        if (r.overridden || r.overriddenFrom) policyOverrides += 1;
      } catch { /* never throws */ }
      try {
        const snap = r.findings && typeof r.findings === 'object' ? r.findings : null;
        const blocking = snap && Array.isArray(snap.blocking) ? snap.blocking : [];
        for (const finding of blocking) {
          const id = finding && typeof finding.ruleId === 'string' ? finding.ruleId : null;
          if (!id) continue;
          ruleCounts.set(id, (ruleCounts.get(id) || 0) + 1);
        }
      } catch { /* never throws */ }
      try {
        if (typeof r.timestamp === 'string' && r.timestamp) {
          const t = Date.parse(r.timestamp);
          if (!Number.isNaN(t) && t < sinceTime) {
            sinceTime = t;
            since = r.timestamp;
          }
        }
      } catch { /* never throws */ }
    }
    const byRule = [...ruleCounts.entries()]
      .map(([ruleId, count]) => ({ ruleId, count }))
      .sort((a, b) => (b.count - a.count) || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
    return { totals, byRule, policyOverrides, window: { receipts, since } };
  }

  // Ledger-integrity check (display only — recomputed server-side via
  // lib/receipt.js: every in-scope receipt is hash-verified with
  // verifyReceipt and per-repo+pr prev_receipt_id linkage is checked
  // against the full ledger order, so repo/pr filters never cause false
  // linkage failures. Returns an integrity result with 200 in both
  // cases, never a transport error for bad content.)
  function verifyLedgerChain(filter) {
    let chain = [];
    try {
      chain = noLedger ? [] : loadLedger(ledgerPath);
    } catch (err) {
      throw new HttpError(500, err && err.message ? String(err.message) : 'ledger unavailable');
    }
    if (!Array.isArray(chain)) chain = [];
    const f = filter || { repo: null, pr: null };
    const bad = [];
    const pushBad = (id) => {
      if (!bad.includes(id)) bad.push(id);
    };
    const lastByKey = new Map();
    let checked = 0;
    for (let i = 0; i < chain.length; i += 1) {
      const r = chain[i];
      if (!r || typeof r !== 'object') {
        if (f.repo === null && f.pr === null) {
          checked += 1;
          pushBad(`unknown-${i}`);
        }
        continue;
      }
      let key = null;
      try {
        key = `${typeof r.repo === 'string' ? r.repo : String(r.repo)}\0${String(r.prNumber)}`;
      } catch {
        key = null;
      }
      const inScope = (f.repo === null || r.repo === f.repo)
        && (f.pr === null || String(r.prNumber) === String(f.pr));
      if (inScope) {
        checked += 1;
        const id = typeof r.receipt_id === 'string' && r.receipt_id ? r.receipt_id : `unknown-${i}`;
        let valid = false;
        try {
          valid = verifyReceipt(r).valid === true;
        } catch {
          valid = false;
        }
        if (!valid) pushBad(id);
        try {
          if (key === null) {
            pushBad(id);
          } else {
            const expected = lastByKey.has(key) ? lastByKey.get(key) : null;
            const actual = r.prev_receipt_id === undefined ? null : r.prev_receipt_id;
            if (actual !== expected) pushBad(id);
          }
        } catch {
          pushBad(id);
        }
      }
      try {
        if (key !== null && typeof r.receipt_id === 'string' && r.receipt_id) {
          lastByKey.set(key, r.receipt_id);
        }
      } catch { /* never throws */ }
    }
    if (bad.length > 0) return { ok: false, bad };
    return { ok: true, checked };
  }

  // PR-detail record (display only — aggregated from the ledger receipts
  // written by finishReview; severity/blocking flags are recomputed from
  // lib/rulepack at serve time, never trusted from stored flags).
  // stale is pure head-drift: true only when the caller supplies
  // ?head= and it differs from the ledger HEAD. A stored STALE verdict
  // stays visible via `verdict`, not via this flag.
  function parsePrPath(path) {
    const prefix = '/api/pr/';
    if (!path.startsWith(prefix)) return null;
    let parts;
    try {
      parts = path.slice(prefix.length).split('/').filter((s) => s.length > 0)
        .map((s) => decodeURIComponent(s));
    } catch {
      throw new HttpError(400, 'malformed pr path');
    }
    if (parts.length < 2) throw new HttpError(400, 'missing repo or pr');
    const prRaw = parts[parts.length - 1];
    const repo = parts.slice(0, -1).join('/');
    if (!repo || !prRaw) throw new HttpError(400, 'missing repo or pr');
    const prNumber = /^-?\d+$/.test(prRaw) ? Number(prRaw) : prRaw;
    return { repo, prNumber };
  }

  function enrichFinding(f) {
    const severity = (f && SEVERITY_MAP[f.ruleId]) || 'unknown';
    return {
      ruleId: f.ruleId,
      file: f.file,
      line: f.line ?? null,
      evidence: f.evidence ?? '',
      severity,
      blocking: BLOCKING_SEVERITIES.has(severity),
      // AI-confidence is a model estimate and never evidence: it is
      // reported on its own key, never merged into verificationState.
      aiConfidence: (f && typeof f.aiConfidence === 'number') ? f.aiConfidence : null,
      verificationState: (f && (f.verification_state || f.verificationState)) || 'unknown',
      evidenceRefs: Array.isArray(f && f.evidenceRefs) ? f.evidenceRefs : [],
    };
  }

  function buildPrRecord(repo, prNumber, requestedHead) {
    const chain = noLedger ? [] : loadLedger(ledgerPath);
    const entries = chain.filter((e) => e && e.repo === repo && String(e.prNumber) === String(prNumber));
    if (entries.length === 0) throw new HttpError(404, 'no record for this repo+pr');
    const latest = entries[entries.length - 1];
    const snap = (latest.findings && typeof latest.findings === 'object') ? latest.findings : {};
    const blocking = (snap.blocking || []).map(enrichFinding);
    const nonBlocking = (snap.nonBlocking || []).map(enrichFinding);
    const silenced = (snap.silenced || []).map(enrichFinding);
    const head = (requestedHead !== undefined && requestedHead !== null && requestedHead !== '')
      ? String(requestedHead) : null;
    const stale = head !== null && head !== latest.headSha;
    // Sealed evidence attached to the latest findings (evidence id IS its
    // sha256 per lib/evidence.js, so id and hash coincide by construction).
    const evidence = [];
    for (const f of [...blocking, ...nonBlocking, ...silenced]) {
      for (const id of f.evidenceRefs) {
        evidence.push({ id, hash: id, ruleId: f.ruleId, file: f.file, line: f.line });
      }
    }
    const activity = entries.map((e, i) => ({
      seq: i + 1,
      type: 'receipt',
      receiptId: e.receipt_id,
      prevReceiptId: e.prev_receipt_id || null,
      verdict: e.verdict,
      headSha: e.headSha,
      timestamp: e.timestamp,
      counts: e.counts || null,
    }));
    return {
      repo,
      prNumber,
      headSha: latest.headSha,
      requestedHead: head,
      stale,
      staleReason: stale ? `requested head ${head} differs from ledger head ${latest.headSha}` : null,
      verdict: latest.verdict,
      rulePackVersion: latest.rulePackVersion,
      blocking,
      nonBlocking,
      silenced,
      counts: latest.counts || null,
      receiptId: latest.receipt_id,
      receipt: latest,
      evidence,
      activity,
    };
  }

  // Finding-detail record (display only — one finding resolved by
  // (repo, prNumber, ruleId, line) from the LATEST ledger receipt for
  // that repo+pr; 404 when the latest receipt carries no such finding).
  // history lists every receipt for this repo+pr whose snapshot touched
  // the same ruleId+line, oldest first (spans heads by construction).
  function parseFindingPath(path) {
    const prefix = '/api/finding/';
    if (!path.startsWith(prefix)) return null;
    let parts;
    try {
      parts = path.slice(prefix.length).split('/').filter((s) => s.length > 0)
        .map((s) => decodeURIComponent(s));
    } catch {
      throw new HttpError(400, 'malformed finding path');
    }
    if (parts.length < 4) throw new HttpError(400, 'missing repo, pr, rule or line');
    const lineRaw = parts[parts.length - 1];
    const ruleId = parts[parts.length - 2];
    const prRaw = parts[parts.length - 3];
    const repo = parts.slice(0, -3).join('/');
    if (!repo || !prRaw || !ruleId || !lineRaw) throw new HttpError(400, 'missing repo, pr, rule or line');
    if (!/^-?\d+$/.test(lineRaw)) throw new HttpError(400, 'line must be an integer');
    const prNumber = /^-?\d+$/.test(prRaw) ? Number(prRaw) : prRaw;
    return { repo, prNumber, ruleId, line: Number(lineRaw) };
  }

  function buildFindingRecord(repo, prNumber, ruleId, line, requestedHead) {
    const chain = noLedger ? [] : loadLedger(ledgerPath);
    const entries = chain.filter((e) => e && e.repo === repo && String(e.prNumber) === String(prNumber));
    if (entries.length === 0) throw new HttpError(404, 'no record for this repo+pr');
    const latest = entries[entries.length - 1];
    const snap = (latest.findings && typeof latest.findings === 'object') ? latest.findings : {};
    const all = [...(snap.blocking || []), ...(snap.nonBlocking || []), ...(snap.silenced || [])].map(enrichFinding);
    const match = all.find((f) => f.ruleId === ruleId && Number(f.line) === Number(line));
    if (!match) throw new HttpError(404, 'no such finding on the latest receipt');
    // Sealed evidence attached to this finding only.
    const evidence = [];
    for (const id of match.evidenceRefs) {
      evidence.push({ id, hash: id, ruleId: match.ruleId, file: match.file, line: match.line });
    }
    const history = [];
    entries.forEach((e, i) => {
      const esnap = (e.findings && typeof e.findings === 'object') ? e.findings : {};
      const ef = [...(esnap.blocking || []), ...(esnap.nonBlocking || []), ...(esnap.silenced || [])];
      if (ef.some((f) => f && f.ruleId === ruleId && Number(f.line) === Number(line))) {
        history.push({
          seq: i + 1,
          receiptId: e.receipt_id,
          headSha: e.headSha,
          verdict: e.verdict,
          timestamp: e.timestamp,
          counts: e.counts || null,
        });
      }
    });
    const head = (requestedHead !== undefined && requestedHead !== null && requestedHead !== '')
      ? String(requestedHead) : null;
    const stale = head !== null && head !== latest.headSha;
    return { repo, prNumber, headSha: latest.headSha, verdict: latest.verdict, stale, finding: match, evidence, history };
  }

  // Sealed-evidence persistence (opt-in via evidenceStorePath — the
  // store file holds sealed EvidenceItems per lib/evidence-store.js while
  // the verifyRuns registry itself stays in-memory and is still lost on
  // restart. Without evidenceStorePath every helper below is inert and
  // the verify shapes are returned byte-identically. With it, starting a
  // run seals one deterministic item per planned check (content-addressed
  // by (runId, targetSha, check type), so replaying the same start on a
  // fresh instance seals identical items) and persists them through the
  // store's atomic write; run views list those items from the store with
  // an in-memory fallback. The store file is re-opened per
  // evidence-touching request so writes from other instances are visible.
  // Any store failure (missing path, corrupt file, unwritable dir) fails
  // closed with a fixed safe message — raw store errors, file paths and
  // file contents never reach the response).
  const evidenceStorePathSet = typeof evidenceStorePath === 'string' && evidenceStorePath.trim() !== '';

  function loadEvidenceStore() {
    try {
      return createEvidenceStore(evidenceStorePath);
    } catch {
      throw new HttpError(500, 'evidence store unavailable');
    }
  }

  function sealRunEvidence(run) {
    return run.checks.map((c) => sealEvidence({
      runId: run.id,
      targetSha: run.targetSha,
      type: c.type,
      command: `verify:${c.type}`,
      exitCode: null,
      result: 'PENDING',
      artifacts: [],
    }));
  }

  function persistRunEvidence(items) {
    const store = loadEvidenceStore();
    try {
      for (const item of items) store.put(item);
    } catch {
      throw new HttpError(500, 'evidence store unavailable');
    }
  }

  // Evidence entries for a run view: stored items first (ids + hashes as
  // persisted), falling back to the items sealed at start when the store
  // holds nothing for this run (e.g. the store file was removed).
  function runEvidenceEntries(run) {
    const store = loadEvidenceStore();
    let items;
    try {
      items = store.listByRun(run.id);
    } catch {
      throw new HttpError(500, 'evidence store unavailable');
    }
    const src = items.length > 0 ? items : (run.sealedEvidence || []);
    return src.map((e) => ({
      id: e.id,
      hash: e.outputHash,
      runId: e.runId,
      type: e.type,
      targetSha: e.targetSha,
    }));
  }

  // Verification runs (display only — an in-memory registry keyed by run
  // id, never persisted: entries live in this server process and are lost
  // on restart. Documented limit: at most MAX_VERIFY_RUNS runs are kept;
  // starting past the cap evicts the oldest id first. Check planning is
  // delegated to lib/verify.js planChecks; the console only presents.)
  const verifyRuns = new Map();
  let verifySeq = 0;
  const MAX_VERIFY_RUNS = 500;

  function startVerifyRun(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'invalid JSON body');
    }
    const repo = typeof body.repo === 'string' && body.repo.trim() ? body.repo.trim() : null;
    const prRaw = body.prNumber ?? body.pr;
    const prNumber = typeof prRaw === 'number' && Number.isInteger(prRaw)
      ? prRaw
      : (typeof prRaw === 'string' && /^-?\d+$/.test(prRaw.trim()) ? Number(prRaw.trim()) : null);
    const ruleId = typeof body.ruleId === 'string' && body.ruleId ? body.ruleId : null;
    const line = typeof body.line === 'number' && Number.isInteger(body.line)
      ? body.line
      : (typeof body.line === 'string' && /^-?\d+$/.test(body.line.trim()) ? Number(body.line.trim()) : null);
    if (!repo || prNumber === null || !ruleId || line === null) {
      throw new HttpError(400, 'repo, prNumber, ruleId and integer line are required');
    }
    const chain = noLedger ? [] : loadLedger(ledgerPath);
    const entries = chain.filter((e) => e && e.repo === repo && String(e.prNumber) === String(prNumber));
    if (entries.length === 0) throw new HttpError(404, 'no record for this repo+pr');
    const latest = entries[entries.length - 1];
    const snap = (latest.findings && typeof latest.findings === 'object') ? latest.findings : {};
    const match = [...(snap.blocking || []), ...(snap.nonBlocking || []), ...(snap.silenced || [])]
      .find((f) => f && f.ruleId === ruleId && Number(f.line) === line);
    if (!match) throw new HttpError(404, 'no such finding on the latest receipt');
    const types = planChecks({ ruleId: match.ruleId });
    verifySeq += 1;
    const id = `VR-${String(verifySeq).padStart(4, '0')}`;
    const run = {
      id,
      findingRef: { repo, prNumber, ruleId, line },
      targetSha: latest.headSha,
      // Mirrors lib/verify.js PENDING; runs never advance server-side (the
      // console presents planned checks, it does not execute them).
      status: 'PENDING',
      checks: types.map((type) => ({ type, status: 'PENDING' })),
      evidenceIds: Array.isArray(match.evidenceRefs) ? [...match.evidenceRefs] : [],
    };
    // Seeded ledger finding for operator-driven completion: the console
    // never executes checks itself (VibeSec), but completeRun() needs a
    // finding object to transition + audit. Bound here at start so the
    // complete step resolves the same finding. Internal only — never
    // exposed in the run view.
    try {
      run.finding = createFinding({
        ruleId: match.ruleId,
        file: typeof match.file === 'string' && match.file ? match.file : 'unknown',
        line,
        evidence: typeof match.evidence === 'string' ? match.evidence : '',
        targetSha: latest.headSha,
        actor: 'human',
      });
    } catch {
      run.finding = {
        id: `${id}-finding`,
        ruleId: match.ruleId,
        file: typeof match.file === 'string' && match.file ? match.file : 'unknown',
        line,
        evidence: typeof match.evidence === 'string' ? match.evidence : '',
        targetSha: latest.headSha,
        verification_state: 'HYPOTHESIS',
        evidenceRefs: [],
      };
    }
    if (evidenceStorePathSet) {
      // Fail closed before registering: a corrupt/unwritable store 500s
      // and leaves no half-registered run behind.
      const sealed = sealRunEvidence(run);
      persistRunEvidence(sealed);
      run.sealedEvidence = sealed;
      for (const item of sealed) run.evidenceIds.push(item.id);
    }
    verifyRuns.set(id, run);
    while (verifyRuns.size > MAX_VERIFY_RUNS) {
      verifyRuns.delete(verifyRuns.keys().next().value);
    }
    return verifyRunView(run);
  }

  function verifyRunView(run) {
    const chain = noLedger ? [] : loadLedger(ledgerPath);
    const entries = chain.filter((e) => e && e.repo === run.findingRef.repo && String(e.prNumber) === String(run.findingRef.prNumber));
    const ledgerHead = entries.length > 0 ? entries[entries.length - 1].headSha : null;
    const stale = ledgerHead !== null && ledgerHead !== run.targetSha;
    const done = run.checks.filter((c) => c.status !== 'PENDING' && c.status !== 'RUNNING').length;
    const view = {
      id: run.id,
      findingRef: { ...run.findingRef },
      targetSha: run.targetSha,
      status: run.status,
      progress: { done, total: run.checks.length },
      checks: run.checks.map((c) => ({ type: c.type, status: c.status })),
      evidenceIds: [...run.evidenceIds],
      stale,
      staleReason: stale ? `run targets ${run.targetSha} but ledger head is ${ledgerHead}` : null,
      ledgerHead,
    };
    // Appended only when a store is configured, so the unconfigured shape
    // stays byte-identical. Entries carry the persisted hashes.
    if (evidenceStorePathSet) view.evidence = runEvidenceEntries(run);
    return view;
  }

  // Operator-driven run completion (NO server-side exec — VibeSec). The
  // operator ran the planned checks out-of-band and asserts the results;
  // the console only records them via lib/verify.js completeRun() (which
  // transitions the seeded finding + appends audit). Results are labeled
  // assertedBy: 'operator' (caller token identity) in the response.
  //
  // Body: { results: [{ type, status, exitCode? }], evidence?: [sealed] }.
  // Mass-assignment guard: only results/evidence at top level and only
  // type/status/exitCode per result entry — any unknown field 400s.
  // Fail-closed: missing required check results 400 with nothing mutated;
  // evidence seal/targetSha mismatches 400 with nothing mutated;
  // already-terminal runs 409 (no double-complete); unknown runs 404.
  function completeVerifyRun(id, body) {
    const run = verifyRuns.get(id);
    if (!run) throw new HttpError(404, 'no such verification run');
    if (run.status === 'PASS' || run.status === 'FAIL') {
      throw new HttpError(409, 'run already complete');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'invalid JSON body');
    }
    for (const k of Object.keys(body)) {
      if (k !== 'results' && k !== 'evidence') {
        throw new HttpError(400, `unknown field "${k}"`);
      }
    }
    if (!Array.isArray(body.results)) {
      throw new HttpError(400, 'results must be an array');
    }
    const evidenceItems = body.evidence === undefined ? [] : body.evidence;
    if (!Array.isArray(evidenceItems)) {
      throw new HttpError(400, 'evidence must be an array');
    }
    const allowedResultKeys = new Set(['type', 'status', 'exitCode']);
    for (const r of body.results) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) {
        throw new HttpError(400, 'results entries must be objects with type and status');
      }
      for (const k of Object.keys(r)) {
        if (!allowedResultKeys.has(k)) {
          throw new HttpError(400, `unknown field "${k}"`);
        }
      }
      if (typeof r.type !== 'string' || r.type.trim() === '') {
        throw new HttpError(400, 'result type is required');
      }
      if (typeof r.status !== 'string' || r.status.trim() === '') {
        throw new HttpError(400, 'result status is required');
      }
      if ('exitCode' in r && r.exitCode !== null && r.exitCode !== undefined
        && !Number.isInteger(r.exitCode)) {
        throw new HttpError(400, 'exitCode must be an integer');
      }
      const key = String(r.status).trim().toUpperCase().replace(/[\s-]+/g, '_');
      const known = ['PASS', 'PASSED', 'OK', 'SUCCESS', 'SUCCESSFUL',
        'FAIL', 'FAILED', 'FAILURE', 'ERROR',
        'REFUTE', 'REFUTED', 'REFUTES', 'NOT_REPRODUCED', 'NOTREPRODUCED', 'DISPROVED'];
      if (!known.includes(key)) {
        throw new HttpError(400, `unknown check outcome "${r.status}"`);
      }
    }
    const required = run.checks.map((c) => c.type);
    const seen = new Set(body.results.map((r) => r.type));
    if (body.results.length !== seen.size) {
      throw new HttpError(400, 'duplicate result for check type');
    }
    const missing = required.filter((t) => !seen.has(t));
    if (missing.length > 0) {
      throw new HttpError(400, `BLOCKED: missing result for required check(s): ${missing.join(', ')}`);
    }
    for (const t of seen) {
      if (!required.includes(t)) {
        throw new HttpError(400, `unknown check type "${t}"`);
      }
    }
    // Re-validate every evidence item before mutating anything: seal
    // check (id === outputHash === recomputed content hash) plus
    // targetSha must equal the run targetSha.
    for (const ev of evidenceItems) {
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
        throw new HttpError(400, 'evidence items must be sealed evidence objects');
      }
      if (typeof ev.id !== 'string' || ev.id === ''
        || typeof ev.outputHash !== 'string' || ev.outputHash === '') {
        throw new HttpError(400, 'invalid evidence seal');
      }
      if (ev.id !== ev.outputHash) {
        throw new HttpError(400, 'invalid evidence seal');
      }
      let recomputed;
      try {
        recomputed = hashBody({
          runId: ev.runId ?? null,
          targetSha: ev.targetSha ?? null,
          type: ev.type ?? null,
          command: ev.command ?? null,
          exitCode: ev.exitCode ?? null,
          result: ev.result ?? null,
          artifactRefs: Array.isArray(ev.artifactRefs) ? [...ev.artifactRefs] : ev.artifactRefs,
        });
      } catch {
        throw new HttpError(400, 'invalid evidence seal');
      }
      if (recomputed !== ev.outputHash) {
        throw new HttpError(400, 'invalid evidence seal');
      }
      if (ev.targetSha !== run.targetSha) {
        throw new HttpError(400,
          `INVALID_VERIFICATION: evidence targetSha (${ev.targetSha}) does not match run targetSha (${run.targetSha})`);
      }
    }
    // Resolve the seeded finding (bound at start; reconstructed from the
    // ledger when absent so older in-memory runs still complete).
    let finding = run.finding;
    if (!finding || typeof finding !== 'object' || !finding.id) {
      const chain = noLedger ? [] : loadLedger(ledgerPath);
      const entries = chain.filter((e) => e && e.repo === run.findingRef.repo
        && String(e.prNumber) === String(run.findingRef.prNumber));
      const latest = entries.length > 0 ? entries[entries.length - 1] : null;
      const snap = latest && latest.findings && typeof latest.findings === 'object' ? latest.findings : {};
      const match = [...(snap.blocking || []), ...(snap.nonBlocking || []), ...(snap.silenced || [])]
        .find((f) => f && f.ruleId === run.findingRef.ruleId && Number(f.line) === Number(run.findingRef.line));
      try {
        finding = createFinding({
          ruleId: run.findingRef.ruleId,
          file: (match && typeof match.file === 'string' && match.file) || 'unknown',
          line: run.findingRef.line,
          evidence: (match && typeof match.evidence === 'string' && match.evidence) || '',
          targetSha: run.targetSha,
          actor: 'human',
        });
      } catch (err) {
        throw new HttpError(400, err.message);
      }
      run.finding = finding;
    }
    const fromState = finding.verification_state || null;
    // Persist operator evidence first (fail-closed before mutation when a
    // store is configured). Items are re-frozen for the store's seal gate;
    // content is unchanged so the recomputed hash still matches.
    if (evidenceStorePathSet && evidenceItems.length > 0) {
      const store = loadEvidenceStore();
      try {
        for (const ev of evidenceItems) {
          const frozen = Object.freeze({
            ...ev,
            artifactRefs: Object.freeze(Array.isArray(ev.artifactRefs) ? [...ev.artifactRefs] : ev.artifactRefs),
          });
          store.put(frozen);
        }
      } catch {
        throw new HttpError(500, 'evidence store unavailable');
      }
      if (!Array.isArray(run.sealedEvidence)) run.sealedEvidence = [];
      for (const ev of evidenceItems) {
        if (!run.sealedEvidence.some((e) => e && e.id === ev.id)) run.sealedEvidence.push(ev);
      }
    }
    const libResults = body.results.map((r) => ({ type: r.type, status: r.status }));
    try {
      completeRun(finding, run, libResults, evidenceItems, { actor: 'human' });
    } catch (err) {
      if (err && (err.code === 'BLOCKED' || err.code === 'INVALID_VERIFICATION')) {
        throw new HttpError(400, err.message);
      }
      if (err && /already complete|terminal/.test(err.message || '')) {
        throw new HttpError(409, 'run already complete');
      }
      throw new HttpError(400, err && err.message ? String(err.message) : 'cannot complete run');
    }
    for (const ev of evidenceItems) {
      if (!run.evidenceIds.includes(ev.id)) run.evidenceIds.push(ev.id);
    }
    const toState = finding.verification_state || null;
    const view = verifyRunView(run);
    return {
      ...view,
      finding: { id: finding.id, from: fromState, to: toState, verification_state: toState },
      findingTransition: { from: fromState, to: toState },
      assertedBy: 'operator',
    };
  }

  function listRules() {
    const pack = activePack();
    return {
      pack,
      rules: ruleIdsForPack(pack).map((id) => ({
        id,
        severity: SEVERITY_MAP[id],
        blocks: BLOCKING_SEVERITIES.has(SEVERITY_MAP[id]),
      })),
    };
  }

  function readConfig() {
    try {
      const { config, configHash, path } = loadConfig(configPath);
      return { config, configHash, path };
    } catch (err) {
      throw new HttpError(500, err.message);
    }
  }

  function writeConfig(body) {
    const target = configPath || 'sentinel.config.json';
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, `Invalid sentinel config (must be an object): ${target}`);
    }
    for (const k of Object.keys(body)) {
      if (k !== 'rulePack' && k !== 'exclude') {
        throw new HttpError(400, `Invalid sentinel config (unknown key "${k}"): ${target}`);
      }
    }
    const rulePack = body.rulePack ?? null;
    if (rulePack != null && !SUPPORTED_PACKS.includes(rulePack)) {
      throw new HttpError(400, `Invalid sentinel config (rulePack must be one of ${SUPPORTED_PACKS.join(', ')}): ${target}`);
    }
    const exclude = body.exclude ?? [];
    if (!Array.isArray(exclude) || exclude.some((p) => typeof p !== 'string')) {
      throw new HttpError(400, `Invalid sentinel config (exclude must be an array of strings): ${target}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify({ rulePack, exclude }, null, 2)}\n`);
    const { config, configHash } = loadConfig(target);
    return { config, configHash };
  }

  function serveStatic(pathname, res, send, method) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return send(404, { error: 'not found' });
    }
    if (rel === '/') rel = '/index.html';
    const abs = normalize(join(PUBLIC_DIR, rel));
    if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + sep)) {
      return send(404, { error: 'not found' });
    }
    let st;
    try {
      st = statSync(abs);
    } catch {
      return send(404, { error: 'not found' });
    }
    if (!st.isFile()) return send(404, { error: 'not found' });
    const data = readFileSync(abs);
    res.writeHead(200, {
      'Content-Type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': data.length,
    });
    if (method === 'HEAD') return res.end();
    res.end(data);
  }

  return async function consoleHandler(req, res) {
    const send = (code, obj) => sendJson(res, code, obj);
    try {
      let url;
      try {
        url = new URL(req.url || '/', 'http://console.local');
      } catch {
        throw new HttpError(400, 'bad request target');
      }
      const path = url.pathname;
      const method = req.method || 'GET';

      // Rate-limit accounting runs BEFORE expensive work but the 429 is
      // enforced AFTER the token gate: the bucket counts ALL /api hits
      // (including failed-auth, so unauthenticated floods still consume
      // the IP's budget), while the 401 takes precedence over the 429 so
      // the gate's behavior is unchanged under load.
      let rateInfo = null;
      if (path.startsWith('/api/') && path !== '/api/healthz') {
        const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
        if (!(exemptLoopback && isLoopbackIp(ip))) {
          rateInfo = limiter.check(ip);
        }
      }

      if (token && path.startsWith('/api/') && path !== '/api/healthz') {
        if (req.headers.authorization !== `Bearer ${token}`) {
          throw new HttpError(401, 'unauthorized');
        }
      }

      if (rateInfo && rateInfo.limited) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'X-Content-Type-Options': 'nosniff',
          'Retry-After': String(rateInfo.retryAfter),
          'Content-Length': Buffer.byteLength(RATE_LIMITED_BODY),
        });
        return res.end(RATE_LIMITED_BODY);
      }

      if (method === 'GET' && path === '/api/healthz') {
        return send(200, { ok: true, version: VERSION, pack: RULE_PACK_VERSION });
      }
      if (method === 'GET' && path === '/api/repos') {
        const scope = resolveOrgQuery(url.searchParams.get('org'));
        return send(200, { repos: scope ? scope.rows : listRepos() });
      }
      if (method === 'GET' && path === '/api/orgs') {
        if (!orgStorePathSet) return send(404, { error: 'not found' });
        const store = loadOrgStore();
        return send(200, { orgs: store.listOrgs().map((o) => ({ id: o.id, name: o.name })) });
      }
      if (method === 'GET' && path.startsWith('/api/orgs/')) {
        if (!orgStorePathSet) return send(404, { error: 'not found' });
        let parts;
        try {
          parts = path.slice('/api/orgs/'.length).split('/').filter((s) => s.length > 0)
            .map((s) => decodeURIComponent(s));
        } catch {
          throw new HttpError(400, 'malformed org path');
        }
        // 404 (not 403) on unknown org to prevent enumeration.
        if (parts.length !== 2 || parts[1] !== 'repos') return send(404, { error: 'not found' });
        const orgId = parts[0];
        if (!isWellFormedOrgId(orgId)) throw new HttpError(400, 'malformed org id');
        const store = loadOrgStore();
        if (!store.getOrg(orgId)) throw new HttpError(404, 'unknown org');
        return send(200, { repos: orgRepoRows(store, orgId) });
      }
      if (method === 'GET' && path === '/api/ledger') {
        const repo = url.searchParams.get('repo');
        const pr = url.searchParams.get('pr');
        if (!repo || !pr) throw new HttpError(400, 'missing repo or pr');
        const chain = noLedger ? [] : loadLedger(ledgerPath);
        return send(200, {
          receipts: chain.filter((e) => e && e.repo === repo && String(e.prNumber) === String(pr)),
        });
      }
      if (method === 'POST' && path === '/api/review') {
        return send(200, await runReview(await readJson(req)));
      }
      if (method === 'POST' && path === '/api/resolve') {
        return send(200, runResolve(await readJson(req)));
      }
      if (method === 'POST' && path === '/api/verify') {
        return send(200, runVerify(await readJson(req)));
      }
      if (method === 'POST' && path === '/api/verify/start') {
        return send(200, startVerifyRun(await readJson(req)));
      }
      if (method === 'GET' && path === '/api/overview') {
        const scope = resolveOrgQuery(url.searchParams.get('org'));
        return send(200, buildOverview(scope ? scope.rows : null));
      }
      if (method === 'GET' && path === '/api/health/verdicts') {
        return send(200, buildHealthVerdicts(parseOptionalRepoPr(url)));
      }
      if (method === 'GET' && path === '/api/ledger/verify') {
        return send(200, verifyLedgerChain(parseOptionalRepoPr(url)));
      }
      if (method === 'GET' && (path === '/api/pr' || path.startsWith('/api/pr/'))) {
        const parsed = parsePrPath(path);
        if (!parsed) throw new HttpError(400, 'missing repo or pr');
        return send(200, buildPrRecord(parsed.repo, parsed.prNumber, url.searchParams.get('head')));
      }
      if (method === 'GET' && (path === '/api/finding' || path.startsWith('/api/finding/'))) {
        const parsed = parseFindingPath(path);
        if (!parsed) throw new HttpError(400, 'missing repo, pr, rule or line');
        return send(200, buildFindingRecord(parsed.repo, parsed.prNumber, parsed.ruleId, parsed.line, url.searchParams.get('head')));
      }
      if (method === 'POST' && path.startsWith('/api/verify/') && path.endsWith('/complete')) {
        let id;
        try {
          id = decodeURIComponent(path.slice('/api/verify/'.length, -'/complete'.length));
        } catch {
          throw new HttpError(400, 'malformed verify path');
        }
        if (id.endsWith('/')) id = id.slice(0, -1);
        if (!id || id.includes('/')) return send(404, { error: 'not found' });
        return send(200, completeVerifyRun(id, await readJson(req)));
      }
      if (method === 'GET' && path.startsWith('/api/verify/')) {
        let id;
        try {
          id = decodeURIComponent(path.slice('/api/verify/'.length));
        } catch {
          throw new HttpError(400, 'malformed verify path');
        }
        if (!id || id.includes('/')) return send(404, { error: 'not found' });
        const run = verifyRuns.get(id);
        if (!run) throw new HttpError(404, 'no such verification run');
        return send(200, verifyRunView(run));
      }
      if (method === 'GET' && path === '/api/rules') {
        return send(200, listRules());
      }
      if (method === 'GET' && path === '/api/config') {
        return send(200, readConfig());
      }
      if (method === 'PUT' && path === '/api/config') {
        return send(200, writeConfig(await readJson(req)));
      }
      if (path.startsWith('/api/')) return send(404, { error: 'not found' });
      if (method !== 'GET' && method !== 'HEAD') return send(404, { error: 'not found' });
      return serveStatic(path, res, send, method);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      return send(status, { error: err && err.message ? String(err.message) : 'internal error' });
    }
  };
}

export function listen(handler, { port = 8787, host = '127.0.0.1' } = {}) {
  const server = createServer(handler);
  server.listen(port, host);
  return server;
}
