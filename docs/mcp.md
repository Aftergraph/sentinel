# Sentinel MCP server — read-only judge for coding-agent loops

`mcp/sentinel-mcp.js` speaks JSON-RPC 2.0 over stdio (Content-Length
framing), zero dependencies. It makes Sentinel the independent verifier
at the end of any agent loop: Codex/Claude/Cursor writes code, the agent
passes the diff, Sentinel returns a verdict — same deterministic engine
as the CLI (`analyzeDiff`, same rule packs).

## Tools (read-only by construction)

| Tool | Input | Output |
|---|---|---|
| `sentinel_review` | `diff` (or `repo`+`pr` via `gh` [VERIFY]/manual — needs `gh` auth + network), `headSha?`, `rulePack?`, `exclude[]?` | verdict, blocking/nonBlocking/excluded, summary |
| `sentinel_rules_list` | `pack?` | id, severity, blocks-flag per rule |
| `sentinel_verdict_latest` | `repo`, `pr`, `ledgerPath?` | latest receipt or null |
| `sentinel_receipt_verify` | `receipt` | VALID/INVALID offline |
| `sentinel_config_show` | `path?` | validated config (read-only) |
| `sentinel_finding_lifecycle` | `finding?`, `action: validate-transition\|list-states`, `to?`, `reason?`, `actor?` | states, transitions, allowed-next; legality check (ai may not transition; DISMISSED needs a reason). Read-only, never mutates |
| `sentinel_verify_plan` | `ruleId`, `severity?` | severity + planned checks via `planChecks` (read-only, never executes) |
| `sentinel_policy_evaluate` | `policyText`, `repo?`, `path?`, `findings?`, `checks?`, `headSha?` | parse + scope-resolve + evaluate (`allowed`, `verdict`, `reasons`, `policyVersion`); malformed input returns `isError`, never throws. See `docs/policy.md` |
| `sentinel_orgs_list` | `storePath` (required) | org `{id, name}` list + `count`; missing/corrupt file returns `isError`, never throws |
| `sentinel_org_repos` | `storePath` (required), `orgId` | linked repos for one org + `count`; unknown org returns `isError`, never throws |
| `sentinel_evidence_get` | `storePath` (required), `id` | one sealed evidence item with hash revalidation (`{storePath, id, item, valid, count}`); tampered/unknown id returns `isError`, never throws |
| `sentinel_evidence_verify` | `storePath` (required) | `verifyAll` summary (`{storePath, ok, checked, bad, count}`); corrupt file returns `isError`, never throws |
| `sentinel_health_verdicts` | `ledgerPath` (required, no default probing) | verdict totals + top blocking rules from a ledger file (`{ledgerPath, totals, byRule, topRules (= byRule), policyOverrides, window: {receipts, since}}`); missing file returns `isError`, never throws |
| `sentinel_ledger_verify` | `ledgerPath` (required, no default probing) | ledger hash-chain check via `lib/receipt.js` (`{ledgerPath, ok, checked, bad}`); tampered entries reported with bad receipt ids; missing file returns `isError`, never throws |

Error paths (observed live; contract: `test/mcp-health.test.mjs`): missing
`ledgerPath` returns `isError` with
`sentinel_health_verdicts needs ledgerPath as a non-empty string.` (same
shape for `sentinel_ledger_verify`); a missing file returns `isError` with
`sentinel_health_verdicts: ledger file not found (<path>).` Every result
echoes `ledgerPath` so callers can correlate responses. Catalog order is
pinned: the original 12 tools come first, the 2 health/ledger tools append
after them (`TOOLS.length` is 14).

No fix, approve, push, or write tool exists — `decisions.md` #4 holds for
agents too. `fix.submit` arrives only if the owner reverses #4.

## Client setup

Claude Code / Codex / Cursor (`mcpServers`):

```json
{ "mcpServers": { "sentinel": {
    "command": "node",
    "args": ["/path/to/sentinel/mcp/sentinel-mcp.js"] } } }
```

## Cloudflare path (phase 2)

Local stdio covers every current agent client. A remote MCP surface
(Streamable HTTP via Cloudflare `McpAgent`) is the documented follow-up
for shared/team agents — tracked in `docs/cloudflare.md`, not scaffolded
here: remote MCP needs account auth, OAuth, and hosted ledger state that
do not exist yet. No dead code checked in for it.
