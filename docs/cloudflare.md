# Cloudflare hosting — Sentinel

**Decision: Tunnel-first, Workers-later.** Sentinel's stateful parts need
disk (ledger, memory), processes, and outbound GitHub access — none of
which fit Workers. This follows the platform precedent
(`work-intelligence-web`: VDS service + Cloudflare Tunnel, same-origin
API). Workers enter only for stateless edge intake (webhook front door,
remote MCP) once accounts and auth exist.

## What runs where (target)

```text
Cloudflare edge (DNS, TLS, Tunnel ingress)
  │  cloudflared → VDS
  ├─ apps/github  :8787  (webhook receiver, needs GITHUB_* secrets)
  ├─ console      :8788  (spec approved, not built)
  └─ mcp-remote   later  (McpAgent, Streamable HTTP — phase 2)
```

## Tunnel config (example, VDS side)

```yaml
# /etc/cloudflared/config.yml
tunnel: <tunnel-id>
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  - hostname: sentinel-hooks.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

GitHub webhook URL becomes `https://sentinel-hooks.example.com/webhooks/github`.
No firewall holes: only outbound `cloudflared` connections.

## Prerequisites (not done here — needs owner account access)

- Cloudflare account + zone, tunnel created (`cloudflared tunnel create`).
- `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN` as host env (never in repo).
- GitHub App registration (webhook URL above) — App-JWT auth is phase 2;
  the slice runs on a token today.
- Remote MCP (`McpAgent`): OAuth issuer, hosted ledger/DO state — design
  only, no scaffold checked in until then.

## Why not Workers now

The Agents-SDK path (`McpAgent`, Durable Objects, Queues) is the right
home for remote MCP and durable verification missions later. Today it
would be dead code: no account, no auth story, and the verdict engine
shells to `gh` / reads local disk. Tunnel-first ships; Workers graduate
when the stateful core has a hosted-state design.

## Security posture (VibeSec audit, 2026-09-07)

- Webhook HMAC verified with `timingSafeEqual`; missing secret fails
  closed (401 everything; boot exits 1 without secrets).
- 1MB webhook body cap; JSON-only API with `nosniff`; error bodies carry
  messages, never stacks.
- Platform client calls only `api.github.com` with repo/PR taken from the
  signature-verified payload — no user-controlled URLs are fetched (SSRF N/A).
- Card markdown sanitizes finding evidence (whitespace collapsed, 300-char
  cap; GitHub sanitizes the rest). `lib/` findings are untouched.
- MCP stdio needs no auth (client-spawned local process, per MCP norm);
  PR-mode validates `owner/name` + integer before any shell use.
