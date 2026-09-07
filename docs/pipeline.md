# Verification pipeline — Sentinel by Aftergraph

Finding → planned checks → isolated run → sealed evidence → finding
transition. Sources of truth: `lib/verify.js`, `lib/runner.js`,
`lib/evidence.js`, `lib/pipeline.js`, `lib/finding.js` headers (quoted
below from the implementation); CLI: `sentinel verify run`;
presentation-only console routes: `POST /api/verify/start`,
`GET /api/verify/:id`; tenant registry: `lib/org-store.js`.

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

## Org/workspace registry (`lib/org-store.js`)

File-backed JSON tenant registry (`organizations`, `workspaces`,
`memberships`, `repos`; ids `org_`/`ws_`/`repo_` + 12 hex chars;
roles `owner | admin | member`, first membership must be `owner`).
Fail-closed on every mutation (unknown org/workspace, cross-org
workspace link, duplicate repo per org, non-owner/admin role change) and
on corrupt store files (throws, never silently resets); writes are atomic
(tmp + rename); every mutation appends one audit event. Console scoping
(`GET /api/repos?org=`, `GET /api/overview?org=`,
`GET /api/orgs/:id/repos`) reads this store via the programmatic
`orgStorePath` server option — **not** exposed as a `sentinel serve`
flag, so under plain `sentinel serve` org routes answer 404 and `?org=`
is ignored (v1a shapes byte-identical).
