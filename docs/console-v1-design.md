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
- Store flags: `--evidence-store <path>` (sealed-evidence persistence for
  verify runs, `docs/pipeline.md`) and `--org-store <path>` (org scoping
  for `/api/orgs*` + `?org=`, §4). Both flags appear on the
  `bin/sentinel.js --help` `serve` usage line.
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
| `POST /api/verify/start` | `{repo, prNumber\|pr, ruleId, line}` | planned run (`VR-0001…`, `PENDING`, checks via `planChecks`); runs never advance server-side, at most 500 runs kept (oldest evicted) and state lost on restart. With `--evidence-store` the start also seals + persists one evidence item per check and the view gains `evidence`. See `docs/pipeline.md` | 400 bad input, 404 unknown repo+PR/finding; 500 `evidence store unavailable` when a store is configured but corrupt |
| `GET /api/verify/:id` | path | run view: checks, `progress.done/total`, `evidenceIds`, ledger-head `stale`/`staleReason` (+ `evidence[]` with a store configured) | 404 no such run; 500 `evidence store unavailable` when a store is configured but corrupt |
| `POST /api/verify/:id/complete` | `{results: [{type, status, exitCode?}], evidence?}` — operator-asserted per-check outcomes for every planned check (the operator ran the checks out-of-band; the server never executes anything). Mass-assignment guard: only `results`/`evidence` top-level keys, only `type`/`status`/`exitCode` per entry; outcome synonyms accepted (`pass/passed/ok`, `fail/failed/error`, `refute/...`) | completed run view + `finding {from, to, verification_state}` + `findingTransition` + `assertedBy: 'operator'` (finding transitions via `lib/verify.js completeRun()` on the start-seeded finding + audit; `GET /api/verify/:id` then shows the completed run) | 400 fail-closed with nothing mutated (unknown fields, missing/duplicate/unknown check results — `BLOCKED` when a required check has no result, unknown outcome, bad evidence seal or `targetSha` mismatch → `INVALID_VERIFICATION`); 404 unknown run; 409 already complete (no second mutation); 401 without token on remote bind |
| `GET /api/health/verdicts` (`?repo=&pr=`) | query (optional filters) | `{totals: {SHIP, DO_NOT_SHIP, STALE, BLOCKED, OVERRIDDEN}, byRule: [{ruleId, count}] desc, policyOverrides, window: {receipts, since}}` derived server-side from the ledger; empty ledger yields all zeros (`{receipts: 0, since: null}`); tampered ledgers still answer 200 (never throws) | 400 `invalid repo filter` / `invalid pr filter` on malformed filters; 401 without token on remote bind (`/api/healthz` exempt) |
| `GET /api/ledger/verify` (`?repo=&pr=`) | query (optional filters) | ledger-integrity check via `lib/receipt.js` (`verifyReceipt` per receipt + per-repo+pr `prev_receipt_id` linkage over full ledger order, so filters never cause false linkage failures): `{ok: true, checked}` or `{ok: false, bad: [...]}` with bad receipt ids; empty ledger yields `{ok: true, checked: 0}`; always 200 on content, never a transport error for bad content | 400 `invalid pr filter` / `invalid repo filter` on malformed filters; 401 without token on remote bind |
| `GET /api/orgs`, `GET /api/orgs/:id/repos` | — | org list (`{orgs: [{id, name}]}`) / linked-repo rows enriched like `/api/repos` (display only, never mutated). Wired by `sentinel serve --org-store <path>` (server option `orgStorePath`, `lib/org-store.js` file; fail-closed boot on a missing file: stderr `Error: cannot read org store file: <path>`, exit 1, no socket) | 404 `{"error":"not found"}` without `--org-store` (plain `sentinel serve`); path scope: 400 malformed org id, 404 unknown org id (never 403, no enumeration) |

`GET /api/repos` and `GET /api/overview` accept `?org=` only when the
server was constructed with `orgStorePath` — wired via
`sentinel serve --org-store <path>` (`lib/org-store.js` file); otherwise
the parameter is ignored (v1a shapes byte-identical), and
malformed/unknown org ids answer 400 (never 404, so org existence cannot
be confused with a missing route). Behavioral contract:
`test/console-org.test.mjs`; CLI flag contract:
`test/cli-orgstore.test.mjs`; health/ledger contract:
`test/console-health.test.mjs` (+ UI markers in
`test/console-health-ui.test.mjs`: `#/health` + `#/integrity` nav,
`vHealth`/`vIntegrity` views polling the aggregate routes only, five
verdict cards never color-only, `esc()` on all rendered ids/counts).
Operator completion contract (`POST /api/verify/:id/complete`, no server
exec, operator-asserted results, `assertedBy: 'operator'`, 400/404/409
gates): `test/console-complete.test.mjs` (8 tests).

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
