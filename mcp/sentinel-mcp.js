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
import { HYPOTHESIS, VERIFYING, CONFIRMED, NOT_REPRODUCED, INDETERMINATE, DISMISSED, TERMINAL_STATES } from '../lib/finding.js';
import { planChecks, severityOf } from '../lib/verify.js';
import { parsePolicy, resolvePolicy, evaluatePolicy } from '../lib/policy.js';

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
  {
    name: 'sentinel_finding_lifecycle',
    description: 'Explain finding verification_state transitions (read-only; never mutates). list-states shows legal states; validate-transition checks if from->to is legal.',
    inputSchema: {
      type: 'object',
      properties: {
        finding: { type: 'object', description: 'Finding object with verification_state.' },
        action: { type: 'string', description: 'validate-transition|list-states.' },
        to: { type: 'string', description: 'Target state for validate-transition.' },
        reason: { type: 'string', description: 'Reason for DISMISSED transitions.' },
        actor: { type: 'string', description: 'Actor for transition rules (ai may not transition).' },
      },
    },
  },
  {
    name: 'sentinel_verify_plan',
    description: 'Plan verification checks for a rule (read-only planning via planChecks; never executes checks).',
    inputSchema: {
      type: 'object',
      properties: {
        ruleId: { type: 'string', description: 'Rule id to plan checks for.' },
        severity: { type: 'string', description: 'Override severity (defaults via rule pack).' },
      },
      required: ['ruleId'],
    },
  },
  {
    name: 'sentinel_policy_evaluate',
    description: 'Parse, scope-resolve, and evaluate a VerificationPolicy (read-only; malformed policy returns isError, never throws).',
    inputSchema: {
      type: 'object',
      properties: {
        policyText: { type: 'string', description: 'Policy YAML text.' },
        repo: { type: 'string', description: 'Repo owner/name for scope resolution.' },
        path: { type: 'string', description: 'File path for scope resolution.' },
        findings: { type: 'array', items: { type: 'object' }, description: 'Findings to evaluate.' },
        checks: { type: 'object', description: 'Check results map.' },
        headSha: { type: 'string', description: 'Commit SHA under evaluation.' },
      },
      required: ['policyText'],
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
    case 'sentinel_finding_lifecycle': {
      // Read-only explanation of lib/finding.js transitions. Never mutates
      // the finding and never appends audit events (no transition() call).
      const action = args.action || 'list-states';
      const finding = args.finding ?? null;
      const from = (typeof finding === 'string' ? finding : null)
        ?? finding?.verification_state ?? finding?.verificationState
        ?? args.from ?? args.currentState ?? args.state ?? args.current ?? null;
      const LEGAL = {
        [HYPOTHESIS]: [VERIFYING, DISMISSED],
        [VERIFYING]: [CONFIRMED, NOT_REPRODUCED, INDETERMINATE, DISMISSED],
      };
      const ALL_STATES = [HYPOTHESIS, VERIFYING, CONFIRMED, NOT_REPRODUCED, INDETERMINATE, DISMISSED];
      const TERMINALS = [...TERMINAL_STATES];
      if (action === 'list-states' || action === 'list_states' || action === 'list') {
        const allowedNext = from && LEGAL[from] ? [...LEGAL[from]] : [];
        return text({
          states: ALL_STATES,
          terminalStates: TERMINALS,
          transitions: LEGAL,
          currentState: from,
          allowedNext,
          rulePackVersion: RULE_PACK_VERSION,
          policyVersion: null,
        });
      }
      if (action === 'validate-transition' || action === 'validate_transition' || action === 'validate') {
        const to = args.to ?? args.toState ?? args.target ?? args.targetState ?? args.next ?? args.nextState ?? args.to_state ?? null;
        if (!from || !to) throw new Error('validate-transition needs finding.verification_state and "to" state.');
        const actor = args.actor ?? finding?.actor ?? 'human';
        let legal = true;
        let explanation = `${from} -> ${to} is legal.`;
        if (actor === 'ai') {
          legal = false;
          explanation = "illegal transition: actor 'ai' may not transition verification_state (may only set confidence/suggest).";
        } else if (TERMINAL_STATES.has(from)) {
          legal = false;
          explanation = `illegal transition: ${from} is terminal, accepts no transitions.`;
        } else if (!LEGAL[from] || !LEGAL[from].includes(to)) {
          legal = false;
          explanation = `illegal transition: ${from} -> ${to}.`;
        } else if (to === DISMISSED) {
          const reason = args.reason ?? finding?.reason ?? args.dismissReason ?? null;
          if (typeof reason !== 'string' || reason.trim() === '') {
            legal = false;
            explanation = 'illegal transition: transition to DISMISSED requires a reason.';
          }
        }
        return text({
          from,
          to,
          legal,
          explanation,
          allowedNext: LEGAL[from] ? [...LEGAL[from]] : [],
          rulePackVersion: RULE_PACK_VERSION,
          policyVersion: null,
        });
      }
      throw new Error(`Unknown action for sentinel_finding_lifecycle: ${action} (expected validate-transition|list-states).`);
    }
    case 'sentinel_verify_plan': {
      // Read-only planning via planChecks only — never creates/runs checks.
      const ruleId = args.ruleId ?? args.finding?.ruleId ?? null;
      if (!ruleId || typeof ruleId !== 'string') throw new Error('sentinel_verify_plan needs ruleId as a non-empty string.');
      const severityInput = args.severity ?? args.finding?.severity ?? undefined;
      const findingLike = severityInput === undefined ? { ruleId } : { ruleId, severity: severityInput };
      const checks = planChecks(findingLike, args.policy ?? null);
      return text({
        ruleId,
        severity: severityOf(findingLike, args.policy ?? null),
        checks,
        rulePackVersion: RULE_PACK_VERSION,
        policyVersion: null,
      });
    }
    case 'sentinel_policy_evaluate': {
      // Parse + resolve + evaluate. Malformed input returns isError (never throws).
      try {
        const policyText = args.policyText ?? args.policy ?? args.yaml ?? args.policyYaml ?? null;
        if (typeof policyText !== 'string' || policyText.trim() === '') {
          return toolError('sentinel_policy_evaluate needs policyText as a non-empty string.');
        }
        const repo = args.repo;
        const path = args.path;
        const findings = args.findings ?? [];
        const checks = args.checks ?? {};
        const headSha = args.headSha ?? 'unknown';
        let policy;
        try {
          policy = parsePolicy(policyText);
        } catch (err) {
          return toolError(err.message);
        }
        try {
          policy = resolvePolicy([policy], { repo, path });
        } catch (err) {
          return toolError(err.message);
        }
        try {
          const result = evaluatePolicy(policy, { findings, checks, headSha });
          return text({
            allowed: result.allowed,
            verdict: result.verdict,
            reasons: result.reasons,
            policyVersion: result.policyVersion,
            rulePackVersion: RULE_PACK_VERSION,
          });
        } catch (err) {
          return toolError(err.message);
        }
      } catch (err) {
        return toolError(err.message);
      }
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
