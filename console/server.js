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
import {
  RULE_PACK_VERSION,
  SUPPORTED_PACKS,
  SEVERITY_MAP,
  BLOCKING_SEVERITIES,
  ruleIdsForPack,
} from '../lib/rulepack.js';

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
  const { ledgerPath, memoryPath, configPath, token, repos, platform, noLedger, topologyPath, orgStatePath } = opts;
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
  function buildOverview() {
    const repos = listRepos();
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
    const recentVerdicts = chain.slice(-10).reverse().map((r) => ({
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

      if (token && path.startsWith('/api/') && path !== '/api/healthz') {
        if (req.headers.authorization !== `Bearer ${token}`) {
          throw new HttpError(401, 'unauthorized');
        }
      }

      if (method === 'GET' && path === '/api/healthz') {
        return send(200, { ok: true, version: VERSION, pack: RULE_PACK_VERSION });
      }
      if (method === 'GET' && path === '/api/repos') {
        return send(200, { repos: listRepos() });
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
      if (method === 'GET' && path === '/api/overview') {
        return send(200, buildOverview());
      }
      if (method === 'GET' && (path === '/api/pr' || path.startsWith('/api/pr/'))) {
        const parsed = parsePrPath(path);
        if (!parsed) throw new HttpError(400, 'missing repo or pr');
        return send(200, buildPrRecord(parsed.repo, parsed.prNumber, url.searchParams.get('head')));
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
