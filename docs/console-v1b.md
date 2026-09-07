# Sentinel Console v1b — topology import + GitHub App auth

Companion to `docs/console-v1-design.md` §6. The console **displays
generated truth, never generates it**: it reads governance files and
renders them, with no verification logic of its own.

## Serve flags

```bash
sentinel serve --topology platform-topology/1.0.json --org-state latest-org-state.json
```

Both flags are optional and independent. Until either is given, the v1a
manual list applies and `/api/repos` keeps its exact v1a shape.

## File formats (tolerant reader)

- `--topology`: an Aftergraph `platform-topology/1.0.json` repo list —
  a bare array, or an object with a `repos`/`projects` array of
  `"owner/name"` strings (objects with a `repo`/`name`/`full_name` key
  also work, and may carry their own `headSha`).
- `--org-state`: a generated `latest-org-state.json` —
  `{ "repos": [{ "repo": "owner/name", "headSha": "<40-hex>" }] }`
  (also accepts `head_sha`/`sha` keys, a bare array, or a
  name→sha map). Repos match by exact name.

Unreadable or malformed files never crash the server: a warning goes to
stderr and the server continues with the remaining sources.

## `GET /api/repos` in v1b mode

Union of `--repo` flags + topology repos + ledger repos. Each row:

```json
{ "repo": "o/r", "headSha": "abc…", "headSource": "org-state",
  "lastVerdict": "SHIP", "receiptId": "…" }
```

`headSource` precedence: `org-state` (exact HEAD match) >
`ledger` > `topology` > `flag`/`ledger` (row origin when no HEAD is
known). `lastVerdict`/`receiptId` come from the ledger whenever the
repo has a local receipt, even when the HEAD shown is org-state truth.

## GitHub App production auth (env)

| Variable | Required | Purpose |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | always | webhook HMAC check |
| `GITHUB_APP_ID` + `GITHUB_APP_KEY_FILE` | preferred | App JWT (RS256, `node:crypto`) → installation token exchange |
| `GITHUB_INSTALLATION_ID` | optional | skip installation discovery (`GET /app/installations`) |
| `GITHUB_TOKEN` | fallback only | plain Bearer when no App credentials are set |

Boot prefers App credentials over `GITHUB_TOKEN` and exits 1 when
neither is present. To go live, the owner provisions a GitHub App
(private key file on disk, App ID, installation ID) and sets the env
above — no code change needed.
