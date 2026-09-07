// Sentinel GitHub App slice (S1): webhook → review → verdict card.
// Owns exactly one top-level comment per PR (update-in-place). Writes to
// GitHub are limited to that card — no merges, no approvals, no pushes.
// lib/ issues every verdict; this file only transports them.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { verifySignature } from './verify.js';
import { renderCard, findOwnComment } from './card.js';
import { createPlatform } from './platform.js';
import {
  analyzeDiff, checkFreshness, computeDelta, loadConfig, environmentInfo,
} from '../../lib/review.js';
import {
  makeReceipt, appendLedger, loadLedger, latestForRepoPr,
} from '../../lib/receipt.js';
import { load as loadMemory } from '../../lib/memory.js';
import { RULE_PACK_VERSION } from '../../lib/rulepack.js';

const MAX_BODY = 1024 * 1024;

export async function routeEvent({ event, payload, platform, opts = {} }) {
  if (event === 'ping') return { handled: true, action: 'pong' };
  if (event !== 'pull_request') return { handled: false, action: `ignored:${event}` };
  if (!['opened', 'synchronize', 'reopened'].includes(payload.action)) {
    return { handled: false, action: `ignored:action:${payload.action}` };
  }

  const repo = payload.repository.full_name;
  const pr = payload.pull_request.number;
  const pack = opts.rulePack || RULE_PACK_VERSION;
  const ledgerFile = opts.ledgerPath;
  const noLedger = opts.noLedger || false;

  const prData = await platform.getPR(repo, pr);
  const headSha = prData.head.sha;
  const baseShaStart = prData.base.sha;
  const diffText = await platform.getDiff(repo, pr);

  const { result, summary } = await analyzeDiff({
    diffText,
    pack,
    excludePatterns: opts.exclude || [],
    resolutions: loadMemory(opts.memoryPath),
    headSha,
    baseSha: baseShaStart,
  });

  // Freshness re-check before posting: never card a superseded commit.
  const prCheck = await platform.getPR(repo, pr);
  const fresh = checkFreshness(
    { headSha, baseSha: baseShaStart },
    { headSha: prCheck.head.sha, baseSha: prCheck.base.sha },
  );

  const chain = noLedger ? [] : loadLedger(ledgerFile);
  const prev = noLedger ? null : latestForRepoPr(chain, repo, pr);
  const prevHeadSha = prev && prev.headSha !== headSha ? prev.headSha : null;
  const delta = prevHeadSha
    ? { prevHeadSha, ...computeDelta((prev.findings || {}).blocking, fresh.fresh ? result.blocking : []) }
    : null;

  const verdict = fresh.fresh ? result.verdict : 'STALE';
  const receipt = makeReceipt({
    repo,
    prNumber: pr,
    headSha,
    baseSha: baseShaStart,
    rulePackVersion: pack,
    verdict,
    findings: fresh.fresh
      ? { blocking: result.blocking, silenced: result.silenced, nonBlocking: result.nonBlocking, excluded: result.excluded }
      : { blocking: [], silenced: [], nonBlocking: [], excluded: [] },
    counts: fresh.fresh
      ? { blocking: result.blocking.length, silenced: result.silenced.length, nonBlocking: result.nonBlocking.length, excluded: result.excluded.length }
      : { blocking: 0, silenced: 0, nonBlocking: 0, excluded: 0 },
    configHash: opts.configHash || null,
    source: 'manual',
    environment: environmentInfo(),
    prevReceiptId: prev ? prev.receipt_id : null,
  });
  if (!noLedger) appendLedger(receipt, ledgerFile);

  const card = renderCard({
    verdict,
    headSha,
    baseSha: baseShaStart,
    rulePackVersion: pack,
    summary,
    blocking: fresh.fresh ? result.blocking : [],
    silenced: fresh.fresh ? result.silenced : [],
    nonBlocking: fresh.fresh ? result.nonBlocking : [],
    delta,
    receiptId: receipt.receipt_id,
    staleReason: fresh.fresh ? null : fresh.reason,
  });

  const comments = await platform.listComments(repo, pr);
  const own = findOwnComment(comments);
  if (own) {
    await platform.patchComment(repo, own.id, card);
    return { handled: true, action: 'updated', verdict, receipt: receipt.receipt_id };
  }
  await platform.postComment(repo, pr, card);
  return { handled: true, action: 'created', verdict, receipt: receipt.receipt_id };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createHandler({ platform, secret, opts }) {
  return async (req, res) => {
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method !== 'POST' || req.url !== '/webhooks/github') return json(404, { error: 'not found' });
      const raw = await readBody(req);
      if (!verifySignature(raw, req.headers['x-hub-signature-256'], secret)) {
        return json(401, { error: 'bad signature' });
      }
      const event = req.headers['x-github-event'];
      const payload = JSON.parse(raw.toString('utf8'));
      const out = await routeEvent({ event, payload, platform, opts });
      return json(200, { ok: true, ...out });
    } catch (err) {
      return json(500, { error: err.message });
    }
  };
}

// Resolve GitHub auth from env. GitHub App credentials win over a plain
// token; throws when neither is present (caller fails closed).
export function createPlatformFromEnv(env = process.env, { fetchImpl } = {}) {
  const extra = fetchImpl ? { fetchImpl } : {};
  if (env.GITHUB_APP_ID && env.GITHUB_APP_KEY_FILE) {
    let privateKeyPem;
    try {
      privateKeyPem = readFileSync(env.GITHUB_APP_KEY_FILE, 'utf8');
    } catch (err) {
      throw new Error(`cannot read GITHUB_APP_KEY_FILE (${env.GITHUB_APP_KEY_FILE}): ${err.message}`);
    }
    return createPlatform({
      appId: env.GITHUB_APP_ID,
      privateKeyPem,
      installationId: env.GITHUB_INSTALLATION_ID || undefined,
      ...extra,
    });
  }
  if (env.GITHUB_TOKEN) return createPlatform({ token: env.GITHUB_TOKEN, ...extra });
  throw new Error('missing GitHub auth: set GITHUB_APP_ID + GITHUB_APP_KEY_FILE, or GITHUB_TOKEN');
}

async function main() {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.error('Missing GITHUB_WEBHOOK_SECRET (fail closed)');
    process.exit(1);
  }
  let platform;
  try {
    platform = createPlatformFromEnv(process.env);
  } catch (err) {
    console.error(`${err.message} (fail closed)`);
    process.exit(1);
  }
  const { config } = loadConfig(process.env.SENTINEL_CONFIG || undefined);
  const handler = createHandler({
    platform,
    secret,
    opts: {
      rulePack: config.rulePack || undefined,
      exclude: config.exclude,
      configHash: null,
      ledgerPath: process.env.SENTINEL_LEDGER || undefined,
      memoryPath: process.env.SENTINEL_MEMORY || undefined,
    },
  });
  const port = parseInt(process.env.PORT || '8787', 10);
  createServer(handler).listen(port, () => console.error(`sentinel github-app listening on :${port}`));
}

const invoked = process.argv[1] && process.argv[1].endsWith('apps/github/app.js');
if (invoked) main();
