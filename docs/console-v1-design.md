# Sentinel Console v1 — Design Spec

**Status:** implemented 2026-09-07 (spec review pending; v1b topology import still deferred).
**Authority:** Aftergraph platform governance (polyrepo, no absorption);
Sentinel `docs/decisions.md` (#3 exact-head, #4 no auto-fix/approve,
#9 deterministic verdict path); `docs/receipts-v0.1.md`
(`sentinel.receipt/0.1`, `sentinel.gov/0.1`).
**Non-goal carrier:** console presents verdicts; only `lib/` issues them.

## 1. Purpose

Give Sentinel a full product surface — local-first web console, PWA-ready —
that works inside Aftergraph's workspace flow across repos, without
weakening any locked product contract. Primary users: the engineer running
reviews (single-repo daily use) and the tech lead watching merge confidence
across repos (board view).

## 2. Placement and boundary (normative)

- Lives at `console/` in the sentinel repo for v1; versions with `lib/`.
- Hard boundary: may import only `lib/` public functions
  (`analyzeDiff`, `computeVerdict`, formatters, receipt fns, `loadConfig`)
  and read ledger/config JSON. Never lib internals, never rule files
  directly. Extraction to its own repo must stay mechanical.
- Copy of `work-intelligence-web` invariants (adapted):
  - UI projection is not canonical state (ledger + GitHub are).
  - `gh` token stays server-side; browser never receives it.
  - Resolve actions require an explicit non-empty reason.
  - Unsupported writes fail closed with an error, never a silent no-op.
  - Every view labels evidence position: `local claim` (ledger) vs
    platform evidence (never claimed by the console).

## 3. Runtime shape

- `sentinel serve [--port 8787] [--host 127.0.0.1]`: single Node process,
  zero dependencies, no build step. Serves static UI + same-origin `/api`.
- Bind rule: non-loopback `--host` requires `SENTINEL_CONSOLE_TOKEN`
  (Bearer on `/api/*`); loopback needs no token. Fail closed otherwise.
- PWA: `manifest.json` + service worker caching the app shell only
  (never verdict data — stale verdicts must never render as fresh).
- Long runs: reviews are synchronous POST (rules are regex, seconds).
  If a run exceeds 55s the server aborts with 504 + no receipt written.

## 4. API contract (same-origin `/api`, JSON)

| Method + path | Input | Output | Errors |
|---|---|---|---|
| `GET /api/healthz` | — | `{ok, version, pack}` | — |
| `GET /api/repos` | — | `{repos: [{repo, headSha?, lastVerdict?, receiptId?}]}`: union of `--repo a/b` flags (repeatable) and repos already in the ledger | — |
| `GET /api/ledger?repo=&pr=` | query | `{receipts: [...]}` newest-last | 400 missing repo/pr |
| `POST /api/review` | `{repo?, pr?, diff?, headSha?, format?}` — pr-mode shells to `gh`, diff-mode uses `analyzeDiff` | `{verdict, findings, summary, delta, receipt}` (same objects as CLI `--format json`) | 400 bad input, 401 no token (remote bind), 502 gh failure. STALE returns 200 with `verdict: STALE` + receipt — HTTP has no exit codes, so clients must branch on the verdict field with the same rule as CLI exit 2: re-run, never treat as failure |
| `POST /api/resolve` | `{ruleId, file, evidence, reason(!), headSha?}` | resolution record | 400 missing/empty reason |
| `POST /api/verify` | `{receipt}` | `{valid, reason?}` | 400 malformed |
| `GET /api/rules` | — | `{pack, rules: [{id, severity, blocks}]}` | — |
| `GET /api/config` | — | `{config, configHash, path?}` | — |
| `PUT /api/config` | full `{rulePack?, exclude[]}` | `{configHash}` | 400 fail-closed (same rules as `loadConfig`) |
| `GET /api/overview` (`?org=` with store) | — | `{confidence, open, blocked, stale, critical, needsAttention, recentVerdicts}` (display roll-up over ledger + topology rows) | — |
| `GET /api/pr/:repo/:pr` (`?head=`) | path | PR-detail record: verdict, blocking/nonBlocking/silenced (severity/blocking recomputed from `lib/rulepack`), counts, receipt, sealed-evidence refs, receipt-chain activity; `stale` is pure head-drift vs `?head=` | 400 malformed path, 404 no record |
| `GET /api/finding/:repo/:pr/:rule/:line` (`?head=`) | path | finding detail (latest receipt) + per-receipt history for that rule+line | 400 malformed path/line, 404 no record or no such finding |
| `POST /api/verify/start` | `{repo, prNumber\|pr, ruleId, line}` | planned run (`VR-0001…`, `PENDING`, checks via `planChecks`); runs never advance server-side, registry kept unbounded in-process and lost on restart (no eviction). With `--evidence-store` the start also seals + persists one evidence item per check and the view gains `evidence`. See `docs/pipeline.md` | 400 bad input, 404 unknown repo+PR/finding; 500 `evidence store unavailable` when a store is configured but corrupt |
| `GET /api/verify/:id` | path | run view: checks, `progress.done/total`, `evidenceIds`, ledger-head `stale`/`staleReason` (+ `evidence[]` with a store configured) | 404 no such run; 500 `evidence store unavailable` when a store is configured but corrupt |
| `GET /api/orgs`, `GET /api/orgs/:id/repos` | — | org list / linked-repo rows enriched like `/api/repos` (display only, never mutated) | 404 without programmatic `orgStorePath` (incl. plain `sentinel serve` — no `--org-store` CLI flag exists); 400 malformed / 404 unknown org id |

`GET /api/repos` and `GET /api/overview` accept `?org=` only when the
server was constructed with the programmatic `orgStorePath` option
(`lib/org-store.js` file); otherwise the parameter is ignored (v1a shapes
byte-identical), and malformed/unknown org ids answer 400 (never 404, so
org existence cannot be confused with a missing route).

All timestamps ISO8601 UTC. All errors `{error: string}` with no stack
leaks. POST routes validate `Content-Type: application/json`.

## 5. Views (v1a)

1. **Board:** repo cards with last verdict pill, HEAD short-sha, pack,
   receipt link. Empty state names the two ways to get data (run a review,
   or point at an existing ledger).
2. **Review detail:** summary header, verdict, blocking/silenced/advisory/
   excluded tables, delta section, receipt block with Verify button
   (VALID green / INVALID red + reason).
3. **Run:** repo+PR fields OR diff textarea/file; format toggle
   (human/json/gov render); result renders into the detail view.
4. **Rules:** pack table (id, severity, blocks?) + version switch
   1.0.0/1.1.0 (read-only; packs change in code, not in UI).
5. **Config:** editor for `exclude[]` + `rulePack` with explicit Save;
   shows resulting `configHash`; malformed input blocked client-side AND
   server-side.
6. **Ledger:** per-repo+PR receipt chains (`receipt_id` → `prev_receipt_id`)
   with per-receipt verify state.

## 6. Org-wide (v1b, deferred but designed)

- `--topology <path>` loads an Aftergraph `platform-topology/1.0.json`
  for the repo list; `--org-state <path>` loads a generated
  `latest-org-state.json` for exact-HEAD-per-repo rows. Console never
  writes either file. Until flags are given, v1a manual list applies.
- No org-state verification logic in the console: it displays generated
  truth, it does not generate it (generator stays in governance repo).

## 7. Testing and acceptance

- `node --test` API tests (no browser): every route incl. error paths,
  resolve-requires-reason, config fail-closed, STALE-in-band shape,
  token gate on remote bind (bind to 127.0.0.1 in tests).
- Equivalence test: UI `/api/review` result deep-equals CLI `--format json`
  for the same diff (same `lib/`, byte-identical by construction — the
  test pins it).
- Smoke: `sentinel serve` boot + `/api/healthz` + one review + PWA files
  served with correct content types.
- Manual: install prompt appears (service worker + manifest), airplane-mode
  shell renders with honest "no data" states (never cached verdicts).
- Acceptance gate: all of the above green + this spec reviewed.

## 8. Compatibility and retirement

- CLI contract untouched: same exit codes, same stdout shapes, `--format`
  outputs unchanged. Console is additive.
- `lib/` public API additions (if any) must keep existing importers green.
- No data migration: ledger JSONL format frozen at `sentinel.receipt/0.1`.

## 9. Explicit non-goals (v1)

Multi-user authN beyond the bearer token, cloud hosting, GitHub App
webhooks (phase C), editing/resolving from aggregated views without a
reason, auto-fix/approve, TUI, editing rule packs in UI, claiming any
platform evidence layer.

## 10. Open questions (need owner call before build)

1. Host repo for production deployment (VDS + tunnel like WI-web, or local-only forever)?
2. Should v1b topology import be in v1 scope if it proves trivial during build?
3. Bearer-token storage for automated (non-browser) API use — env-only, or a token file?

## Appendix — working drafts

TaskIntentDraft: console v1 = governance-clean product surface over v0.1
machine surfaces; success = board + run + verify working locally with
byte-equivalence to CLI; stop = spec review; non-goals per §9.
BaselineUsageDraft: required refs read (decisions #3/#4/#9, receipts-v0.1,
WI-web authority boundary, governance topology/contracts, naming
standard); missing: deployment target (see §10.1); decision: continue.
ImpactStatementDraft: affects new `console/` + `serve` wiring only;
invariants: CLI stdout/exit untouched, ledger format frozen, verdict
authority stays in `lib/`; compat: additive API, no migrations.
