# Sentinel GitHub App slice (S1, in progress)

`apps/github/` receives `pull_request` webhooks, reviews the exact HEAD,
and owns one verdict card per PR (update-in-place via
`<!-- sentinel-verdict -->`). Writes stop at that card: no merges, no
approvals, no pushes. Verdicts come from `lib/`; this slice transports.

## Run (self-host)

```bash
GITHUB_WEBHOOK_SECRET=… GITHUB_TOKEN=… PORT=8787 node apps/github/app.js
```

Optional: `SENTINEL_CONFIG`, `SENTINEL_LEDGER`, `SENTINEL_MEMORY`.
Fail-closed boot: missing secret or token exits 1.

## Behavior

- `opened` / `synchronize` / `reopened` → fetch PR + diff → `analyzeDiff`
  → re-fetch PR (freshness) → receipt → create or patch the card.
- HEAD moved mid-run → STALE card, never a verdict on a superseded commit.
- Receipts chain into the same ledger as the CLI; delta sections appear
  once a prior receipt for the repo+PR exists.

## Cloudflare

Tunnel-first (stateful: ledger disk, `gh`-network, memory file) — see
`docs/cloudflare.md`. A Workers edge intake is future work, not a second
implementation: Workers cannot run this slice's disk/process surface.
