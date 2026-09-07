# Sentinel MCP server — read-only judge for coding-agent loops

`mcp/sentinel-mcp.js` speaks JSON-RPC 2.0 over stdio (Content-Length
framing), zero dependencies. It makes Sentinel the independent verifier
at the end of any agent loop: Codex/Claude/Cursor writes code, the agent
passes the diff, Sentinel returns a verdict — same deterministic engine
as the CLI (`analyzeDiff`, same rule packs).

## Tools (read-only by construction)

| Tool | Input | Output |
|---|---|---|
| `sentinel_review` | `diff` (or `repo`+`pr` via `gh`), `headSha?`, `rulePack?`, `exclude[]?` | verdict, blocking/nonBlocking/excluded, summary |
| `sentinel_rules_list` | `pack?` | id, severity, blocks-flag per rule |
| `sentinel_verdict_latest` | `repo`, `pr`, `ledgerPath?` | latest receipt or null |
| `sentinel_receipt_verify` | `receipt` | VALID/INVALID offline |
| `sentinel_config_show` | `path?` | validated config (read-only) |

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
