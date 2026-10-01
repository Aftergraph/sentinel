# Sentinel GitHub App slice (S1, in progress)

`apps/github/` receives `pull_request` and `workflow_run` webhooks, reviews the exact HEAD,
and owns one verdict card per PR (update-in-place via
`<!-- sentinel-verdict -->`). It can also own exact-HEAD GitHub Check runs:
`sentinel/review` and `sentinel/economic-evidence`. Writes stop at comments/checks:
no merges, approvals, pushes, or repository mutations. Verdicts come from `lib/`
and GitHub Actions evidence; this slice transports and aggregates.

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


## GitHub App permissions and events

Repository permissions:

- **Contents:** Read
- **Pull requests:** Read
- **Issues:** Read & write (single Sentinel verdict card)
- **Actions:** Read (exact-HEAD workflow evidence)
- **Checks:** Read & write (Sentinel-owned check runs)

Subscribe to:

- `pull_request`
- `workflow_run`
- `installation`
- `installation_repositories`

In GitHub App credential mode, Sentinel check runs are always enabled and use the installation token directly for the Checks API. `SENTINEL_GITHUB_CHECKS=1` remains a token-mode compatibility switch; `gh`/a separate token remains fallback only.

### Economic evidence aggregation

For PRs touching `lib/economic-*`, `test/economic-*`, or
`.github/workflows/economic-*`, Sentinel requires the full `test` workflow on
the exact PR HEAD. For v11-v13 surfaces it additionally requires the focused
workflow for the changed component:

- Economic Evidence Pack
- Economic Evidence Campaign
- Economic Source Capture
- Economic Source Generation Ledger

Missing/in-progress required workflows remain pending and never produce a green check. A failed required workflow produces a failing `sentinel/economic-evidence` check. Superseded HEADs are ignored. Workflow success alone is labeled `WORKFLOWS_VERIFIED`; it is never presented as an attested EvidencePack. A PR that changes exactly one canonical `docs/evidence/economic-campaigns/<campaign>/evidence-pack.json` envelope is independently fetched at the exact PR HEAD and re-verified by Sentinel. Only a repository/head-bound envelope whose campaign and immutable pack both verify is labeled `VERIFIED_EVIDENCE_PACK`.


### Runtime health

`GET /healthz` returns a minimal unauthenticated service health object with `checksEnabled`; it exposes no credentials or installation tokens. Use it behind the existing tunnel/service boundary to distinguish an offline App runtime from a GitHub webhook/configuration issue.
