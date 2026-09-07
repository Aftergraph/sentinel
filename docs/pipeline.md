# Verification pipeline — Sentinel by Aftergraph

Finding → planned checks → isolated run → sealed evidence → finding
transition. Sources of truth: `lib/verify.js`, `lib/runner.js`,
`lib/evidence.js`, `lib/pipeline.js`, `lib/finding.js` headers (quoted
below from the implementation); CLI: `sentinel verify run`;
presentation-only console routes: `POST /api/verify/start`,
`GET /api/verify/:id`, `POST /api/verify/:id/complete` (operator-asserted,
no server exec); tenant registry: `lib/org-store.js`.

## Finding lifecycle (`lib/finding.js`)

`HYPOTHESIS -> VERIFYING -> CONFIRMED | NOT_REPRODUCED | INDETERMINATE`;
any non-terminal may go to `DISMISSED` (reason required). Terminals accept
no further transitions. Actor `ai` may only set confidence/suggest — any
`verification_state` transition by `ai` throws. Every
create/transition/confidence-set appends one audit event.

## Check planning (`lib/verify.js`)

Closed check set (8, pinned by test): `BUILD`, `TEST`, `TYPECHECK`,
`LINT`, `STATIC_ANALYSIS`, `SECRET_SCAN`, `CONTRACT_TEST`,
`POLICY_CHECK`.

`planChecks(finding, policy)` is deterministic and offline (pure function
of ruleId/severity/policy): base checks from a severity table
(`security` → `STATIC_ANALYSIS, SECRET_SCAN, POLICY_CHECK`;
`reliability` → `BUILD, TEST, POLICY_CHECK`;
`correctness` → `BUILD, TEST, TYPECHECK`;
`data` → `BUILD, CONTRACT_TEST, POLICY_CHECK`;
`performance` → `BUILD, TEST, CONTRACT_TEST`; `style` → `LINT`),
plus ruleId-keyword overlays (e.g. `secret|private-key` adds
`SECRET_SCAN`, `migration|sql|...` adds `CONTRACT_TEST`), ordered by
`CHECK_TYPES`. `policy.checks` (or a bare array) pins an explicit set;
`policy.extraChecks` unions extras. Unknown check types throw.

Run lifecycle: `createRun` (PENDING) → `startRun` (RUNNING) →
`completeRun` (PASS | FAIL). `completeRun` needs a result
(`pass | fail | refute`, synonyms accepted) for **every** required check —
a missing one throws `BLOCKED` and mutates nothing. Outcome: any refute
→ finding `NOT_REPRODUCED`; all pass → `CONFIRMED`; otherwise the finding
stays/enters `VERIFYING`. Evidence whose `targetSha` mismatches the run
(or finding) throws `INVALID_VERIFICATION`.

## Isolated runner (`lib/runner.js`)

`runLocal({ repoDir, targetSha, checks, timeoutMs, env })`:

1. Copies `repoDir` to a temp dir (never runs in place).
2. Verifies `git rev-parse HEAD` in the copy equals `targetSha` —
   mismatch throws `INVALID_VERIFICATION`, nothing executes.
3. Runs each `{ type, command[] }` sequentially as a bounded child
   (`timeout` kill → `TIMEOUT`; exit 0 → `PASS`, else `FAIL`).
4. Scrubs secrets, truncates output at 64 KiB, seals one EvidenceItem per
   check, appends audit events.
5. Always removes the temp dir (even on timeout/throw).

Child env is allowlist-only (exactly the caller-passed `env`, default
`{}`); timeout defaults to 120 s, max 600 s (above throws). Zero-dep,
no network.

## Sealed evidence (`lib/evidence.js`)

`sealEvidence()` freezes one execution into a content-addressed
EvidenceItem: `id` IS the sha256 of the canonical JSON of all other
fields, so identical inputs seal to identical items
(`Object.frozen`, incl. `artifactRefs`). `attachEvidence()` binds an item
to a finding, throwing `INVALID_VERIFICATION` on `targetSha` mismatch.

## End-to-end pipeline (`lib/pipeline.js`)

`executePipeline({ finding, repoDir, targetSha, commands, env, policy })`
wires planning to the runner: unknown check types in `commands`, missing
commands for required checks, a finding without a pinned `targetSha`, a
`targetSha` disagreement, or an empty plan all throw **before anything
executes** (fail closed — zero evidence never auto-CONFIRMs).
Exit-code mapping: 0 → pass; `refuteExitCode` → refute (`NOT_REPRODUCED`);
any other exit / `TIMEOUT` → fail.

## CLI: `verify run`

```bash
sentinel verify run --finding <ruleId:file:line> --repo-dir <dir> --commands <jsonfile> [--format human|json]
```

`commands` maps each required check type to
`{ command: [argv0, ...args], refuteExitCode?: <non-zero int> }`.
Unknown/misconfigured types fail closed with exit 2 pre-exec (nothing
runs). Human output prints run id, per-check `PASS|FAIL|TIMEOUT`, the
`HYPOTHESIS -> CONFIRMED`-style transition, and sealed evidence ids
(sha256); `--format json` emits `{ run, finding, evidence }`
machine-readably. (Both shapes verified live 2026-09-07 against a
fixture git repo.)

## Console verify routes (display only)

- `POST /api/verify/start` `{ repo, prNumber|pr, ruleId, line }` plans
  checks via `planChecks` and registers an in-memory run (`VR-0001…`,
  status `PENDING`); runs never advance server-side. At most 500 runs are
  kept (oldest evicted); state is lost on restart. 404 when the
  repo+PR or finding is unknown on the latest receipt.
- `GET /api/verify/:id` returns the run view incl. `progress.done/total`,
  `evidenceIds`, and ledger-head staleness (`stale` + `staleReason`).
  With a store configured the view gains an `evidence` array (one entry
  per planned check: `{id, hash, runId, type, targetSha}`).

## Operator completion (`POST /api/verify/:id/complete`)

The console never executes checks server-side (VibeSec). The operator runs
the planned checks out-of-band and asserts the results; the console only
records them via `completeRun()` (`console/server.js` `completeVerifyRun`,
behavioral contract: `test/console-complete.test.mjs`, 8 tests):

- Request: `{ results: [{ type, status, exitCode? }], evidence?: [...] }`.
  Every planned check needs exactly one result (`status` synonyms accepted:
  `pass/passed/ok`, `fail/failed/error`, `refute/...`); `evidence` carries
  operator-sealed EvidenceItems. Mass-assignment guard: only
  `results`/`evidence` top-level keys and only `type`/`status`/`exitCode`
  per result entry — any unknown field 400s.
- Fail closed: missing required check results (`BLOCKED`), duplicate or
  unknown check types, unknown outcomes, bad evidence seals
  (`id`/`outputHash`/recomputed-hash mismatch), and evidence `targetSha`
  mismatches (`INVALID_VERIFICATION`) all answer 400 with nothing mutated
  (the run stays `PENDING`); unknown runs 404; already-terminal runs 409
  (no double-complete). Like the other `/api/*` routes (except
  `/api/healthz`), the route requires the Bearer token on a remote bind
  (401 without it).
- Success records the asserted results through `completeRun()` on the
  finding seeded at start (bound from the ledger finding, `actor: 'human'`,
  `verify_complete` audit event plus the finding-transition event), persists
  operator evidence first when a store is
  configured (500 `evidence store unavailable` on store failure, same as
  the other evidence routes), and answers the run view plus
  `finding {from, to, verification_state}`, `findingTransition`, and
  `assertedBy: 'operator'` — the caller identity the results are labeled
  with. A later `GET /api/verify/:id` shows the completed run.

## Console evidence persistence (`--evidence-store`)

`sentinel serve --evidence-store <path>` opts into sealed-evidence
persistence for console verify runs (server option `evidenceStorePath`;
`createEvidenceStore` per `lib/evidence-store.js`). Without the flag every
helper is inert and the run shapes stay byte-identical (legacy keys only:
`id, findingRef, targetSha, status, progress, checks, evidenceIds, stale,
staleReason, ledgerHead` — no `evidence` key, no store file created).

With the flag, starting a run seals one deterministic item per planned
check (content-addressed, so replaying the same start seals identical
items) and persists them via the store's atomic write; run views list
those items from the store with an in-memory fallback (removing the store
file still serves the start-time sealed items). The store file is
re-opened per evidence-touching request, so evidence survives server
restarts on the same store file (a replayed start reclaims the same
`VR-0001…` id with no duplicate items). The verify-runs registry itself
stays in-memory and is still lost on restart.

Fail closed: a corrupt/unwritable store answers `500
{"error":"evidence store unavailable"}` on evidence routes only
(`POST /api/verify/start`, `GET /api/verify/:id`) — raw store errors,
paths, and contents never reach the response, the corrupt file is never
rewritten, and unrelated routes (e.g. `/api/healthz`, `/api/rules`) are
unaffected. (All shapes above verified live 2026-09-07; behavioral
contract: `test/console-evidence.test.mjs`, 5 tests.)

## Org/workspace registry (`lib/org-store.js`)

File-backed JSON tenant registry (`organizations`, `workspaces`,
`memberships`, `repos`; ids `org_`/`ws_`/`repo_` + 12 hex chars;
roles `owner | admin | member`, first membership must be `owner`).
Fail-closed on every mutation (unknown org/workspace, cross-org
workspace link, duplicate repo per org, non-owner/admin role change) and
on corrupt store files (throws, never silently resets); writes are atomic
(tmp + rename); every mutation appends one audit event. Console scoping
(`GET /api/repos?org=`, `GET /api/overview?org=`,
`GET /api/orgs`, `GET /api/orgs/:id/repos`; see
`docs/console-v1-design.md` §4) reads this store via the server
`orgStorePath` option, wired as `sentinel serve --org-store <path>`
(`bin/sentinel.js` passes the flag through; a missing file fails closed
at boot with stderr `Error: cannot read org store file: <path>`, exit 1,
no socket — observed live, contract: `test/cli-orgstore.test.mjs`). Under
plain `sentinel serve` (no flag) org routes answer 404
`{"error":"not found"}` and `?org=` is ignored (v1a shapes
byte-identical).
