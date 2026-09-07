#!/usr/bin/env node
// Sentinel MCP server — read-only judge for agentic coding loops.
// JSON-RPC 2.0 over stdio with Content-Length framing (MCP spec),
// zero dependencies. Tools never write code, never approve, never push:
// they review diffs, list rules, and read/verify receipts.
//
// Claude Code / Codex / Cursor config:
//   { "mcpServers": { "sentinel": {
//       "command": "node", "args": ["/path/to/sentinel/mcp/sentinel-mcp.js"] } } }
// Remote (Cloudflare McpAgent, Streamable HTTP) is phase 2 — see docs/mcp.md.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { analyzeDiff, localHeadSha } from '../lib/review.js';
import { RULE_PACK_VERSION, SUPPORTED_PACKS, SEVERITY_MAP, BLOCKING_SEVERITIES, ruleIdsForPack } from '../lib/rulepack.js';
import { verifyReceipt, loadLedger, latestForRepoPr, defaultLedgerPath } from '../lib/receipt.js';
import { loadConfig } from '../lib/review.js';

export const SERVER_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch { return '0.0.0'; }
})();

export const TOOLS = [
  {
    name: 'sentinel_review',
    description: 'Review a unified diff (or a GitHub PR) and return a deterministic SHIP/DO_NOT_SHIP verdict with cited findings. Pure function of diff + rule pack.',
    inputSchema: {
      type: 'object',
      properties: {
        diff: { type: 'string', description: 'Unified diff text to review.' },
        repo: { type: 'string', description: 'owner/name for PR mode (needs gh auth).' },
        pr: { type: 'integer', description: 'PR number for PR mode.' },
        headSha: { type: 'string', description: 'Bind local reviews to a commit (e.g. git rev-parse HEAD).' },
        rulePack: { type: 'string', description: `Rule pack version (${SUPPORTED_PACKS.join('|')}).` },
        exclude: { type: 'array', items: { type: 'string' }, description: 'Glob patterns to exclude (reported, never block).' },
      },
    },
  },
  {
    name: 'sentinel_rules_list',
    description: 'List the rule pack: rule ids, severities, and whether each blocks a verdict.',
    inputSchema: {
      type: 'object',
      properties: {
        pack: { type: 'string', description: `Rule pack version (${SUPPORTED_PACKS.join('|')}).` },
      },
    },
  },
  {
    name: 'sentinel_verdict_latest',
    description: 'Latest ledger receipt (verdict) for a repo+PR, if any.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        pr: { type: 'integer' },
        ledgerPath: { type: 'string' },
      },
      required: ['repo', 'pr'],
    },
  },
  {
    name: 'sentinel_receipt_verify',
    description: 'Recompute a receipt hash offline. Returns VALID or INVALID with reason.',
    inputSchema: {
      type: 'object',
      properties: {
        receipt: { type: 'object', description: 'The receipt object to verify.' },
      },
      required: ['receipt'],
    },
  },
  {
    name: 'sentinel_config_show',
    description: 'Read and validate a sentinel.config.json (read-only).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Config path; defaults to ./sentinel.config.json.' },
      },
    },
  },
];

function text(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function toolError(message) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

function fetchPrDiff(repo, pr) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo || '')) || !Number.isInteger(pr)) {
    throw new Error('PR mode needs repo as owner/name and pr as an integer.');
  }
  try {
    return execSync(
      `gh api repos/${repo}/pulls/${pr} -H "Accept: application/vnd.github.v3.diff"`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
  } catch {
    throw new Error(`Cannot fetch PR diff (needs gh auth): ${repo}#${pr}`);
  }
}

export async function dispatch(name, args = {}, ctx = {}) {
  const ledgerPath = ctx.ledgerPath || args.ledgerPath || defaultLedgerPath();
  switch (name) {
    case 'sentinel_review': {
      const pack = args.rulePack || RULE_PACK_VERSION;
      ruleIdsForPack(pack); // throws on unsupported pack
      const diffText = args.diff || ((args.repo && args.pr) ? fetchPrDiff(args.repo, args.pr) : null);
      if (!diffText) throw new Error('Provide diff text, or repo+pr for PR mode.');
      const { result, summary } = await analyzeDiff({
        diffText,
        pack,
        excludePatterns: args.exclude || [],
        resolutions: new Set(),
        headSha: localHeadSha(diffText, args.headSha),
        baseSha: 'mcp-base',
      });
      return text({
        verdict: result.verdict,
        blocking: result.blocking,
        nonBlocking: result.nonBlocking || [],
        excluded: result.excluded || [],
        summary,
        rulePack: pack,
      });
    }
    case 'sentinel_rules_list': {
      const pack = args.pack || RULE_PACK_VERSION;
      return text({
        pack,
        rules: ruleIdsForPack(pack).map((id) => ({
          id,
          severity: SEVERITY_MAP[id],
          blocks: BLOCKING_SEVERITIES.has(SEVERITY_MAP[id]),
        })),
      });
    }
    case 'sentinel_verdict_latest': {
      const entries = loadLedger(ledgerPath);
      const latest = latestForRepoPr(entries, args.repo, args.pr);
      return text({ receipt: latest });
    }
    case 'sentinel_receipt_verify': {
      return text(verifyReceipt(args.receipt));
    }
    case 'sentinel_config_show': {
      const { config, configHash, path } = loadConfig(args.path);
      return text({ config, configHash, path });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export async function handleMessage(msg, ctx = {}) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id: (msg && msg.id) ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'sentinel', version: SERVER_VERSION },
      },
    };
  }
  if (method === 'notifications/initialized') return null;
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    const tool = params && params.name;
    const found = TOOLS.some((t) => t.name === tool);
    if (!found) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${tool}` } };
    }
    try {
      const result = await dispatch(tool, (params && params.arguments) || {}, ctx);
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      return { jsonrpc: '2.0', id, result: toolError(err.message) };
    }
  }
  return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Method not found: ${method}` } };
}

export function createFramer() {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const out = [];
      for (;;) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) break;
        const header = buf.subarray(0, idx).toString('utf8');
        const m = header.match(/Content-Length:\s*(\d+)/i);
        if (!m) { buf = buf.subarray(idx + 4); continue; }
        const len = parseInt(m[1], 10);
        if (buf.length < idx + 4 + len) break;
        const body = buf.subarray(idx + 4, idx + 4 + len).toString('utf8');
        buf = buf.subarray(idx + 4 + len);
        try {
          out.push(JSON.parse(body));
        } catch { /* skip malformed frame */ }
      }
      return out;
    },
  };
}

export function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

async function main() {
  const framer = createFramer();
  process.stdin.resume();
  process.stdin.on('data', async (chunk) => {
    for (const msg of framer.push(chunk)) {
      try {
        const res = await handleMessage(msg, {});
        if (res) process.stdout.write(frame(res));
      } catch (err) {
        process.stderr.write(`sentinel-mcp: ${err.message}\n`);
      }
    }
  });
}

const invoked = process.argv[1] && (process.argv[1].endsWith('sentinel-mcp.js') || process.argv[1].endsWith('sentinel-mcp'));
if (invoked) main();
