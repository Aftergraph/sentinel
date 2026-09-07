# Sentinel Architecture Map

Docs-only guide for future agents. Every path, export, route, and tool
name below was verified against the tree on 2026-09-07.
Test baseline: `npm test` → **414 pass, 0 fail** across the
**44 suite files** listed in `package.json` (which exactly match `test/`).

Authority rule: `lib/` decides, everything else transports or presents.
Review is read-only by construction (ledger + stdout are local).

## 1. Module map

### `lib/` — verdict authority (12 files)

| File | One-line contract | Key exports |
|---|---|---|
| `lib/review.js` | Diff/PR → findings → verdict + receipt; exit-code contract 0 SHIP / 1 DO_NOT_SHIP / 2 STALE | `review`, `analyzeDiff`, `computeVerdict`, `checkFreshness`, `computeDelta`, `resolveFinding`, `toSarif`, `toGov`, `GOV_CONTRACT`, `VALID_FORMATS`, `VERDICT_STRICTNESS`, `loadConfig`, `filterExcluded` |
| `lib/rulepack.js` | Single source of truth: rule IDs, severities, pack versions, blocking set | `RULE_PACK_VERSION` (`1.3.0`), `SUPPORTED_PACKS` (`1.0.0\|1.1.0\|1.2.0\|1.3.0`), `RULE_IDS_BY_PACK`, `SEVERITY_MAP`, `BLOCKING_SEVERITIES`, `ruleIdsForPack` |
| `lib/finding.js` | ENGINE S1 finding lifecycle state machine; actor `ai` may never transition | `HYPOTHESIS`, `VERIFYING`, `CONFIRMED`, `NOT_REPRODUCED`, `INDETERMINATE`, `DISMISSED`, `TERMINAL_STATES`, `createFinding`, `transition`, `setAiConfidence`, `isTerminal` |
| `lib/audit.js` | ENGINE S1 append-only in-memory event log, monotonic `seq` | `append` (+ aliases `appendEvent`, `appendAudit`), `list` (+ aliases), `clear` (+ aliases `reset`, `clearEvents`, `clearAudit`) |
| `lib/verify.js` | ENGINE S3 deterministic finding→checks planner + run lifecycle; closed set of 8 check types | `CHECK_TYPES` (BUILD, TEST, TYPECHECK, LINT, STATIC_ANALYSIS, SECRET_SCAN, CONTRACT_TEST, POLICY_CHECK), `PENDING/RUNNING/PASS/FAIL`, `planChecks`, `createRun`, `startRun`, `completeRun`, `severityOf` |
| `lib/runner.js` | Isolated local check executor: temp-copy repo, HEAD-pinned, allowlist env, seals evidence per check | `runLocal`, `DEFAULT_TIMEOUT_MS` (120000), `MAX_TIMEOUT_MS` (600000), `MAX_OUTPUT_BYTES` (64K) |
| `lib/pipeline.js` | Wires `planChecks` → `createRun`/`startRun` → `runLocal` → `completeRun` into one call | `executePipeline({ finding, repoDir, targetSha, commands, env, policy })` |
| `lib/evidence.js` | ENGINE S2 sealed, frozen, content-addressed evidence items (`id` = sha256 of body) | `sealEvidence`, `attachEvidence`, `hashBody`, `canonicalJson` |
| `lib/evidence-store.js` | File-backed JSON persistence for sealed items; fail-closed seal gate on `put()` | `createEvidenceStore(filePath)` |
| `lib/policy.js` | Versioned verification policies (fail closed): parse → scope-resolve → evaluate + one audit event | `POLICY_API_VERSION`, `POLICY_KIND`, `KNOWN_SEVERITIES`, `parsePolicy`, `resolvePolicy`, `evaluatePolicy`, `policyVersion` |
| `lib/receipt.js` | Content-addressed verdict receipts (`sentinel.receipt/0.1`) + hash-chained per-repo+PR JSONL ledger | `RECEIPT_CONTRACT`, `SOURCE_ENUM`, `makeReceipt`, `receiptIdFor`, `verifyReceipt`, `appendLedger`, `loadLedger`, `latestForRepoPr`, `detectSource`, `defaultLedgerPath` |
| `lib/org-store.js` | File-backed tenant registry: orgs, workspaces, memberships, repos; fail-closed scope checks | `createOrgStore(filePath)` (IDs `org_`/`ws_`/`repo_` + 12 hex; roles owner\|admin\|member, first member must be owner) |
| `lib/memory.js` | Append-only `~/.sentinel/resolutions.jsonl`; `resolve` silences repeat findings across HEADs | `defaultPath`, `fingerprint`, `keyOf`, `load`, `append`, `isSilenced`, `partition` |

### `lib/rules/` — 23 files, 21 in pack

`_diff-parse.js` is the shared unified-diff parser (not a rule).
`no-swallowed-exceptions-in-critical-path.js` ships in-tree but is in
**no pack** by design (name promises critical-path scoping the regex
cannot deliver). Pack sizes: 1.0.0 = 6, 1.1.0 = 20, 1.2.0 = 21, 1.3.0 = 22
(pinned by `test/cli-contract.test.mjs`).

| Rule | Severity | Fires on |
|---|---|---|
| `no-unauthenticated-api-endpoints` | security | Collection route without auth |
| `no-secrets-in-cicd-config` | security | Secrets in `.github/workflows/*.y(a)ml` |
| `no-eval-with-dynamic-input` | security | `eval()` with dynamic input in JS/TS |
| `no-disabled-tls-verification` | security | TLS verification disabled |
| `no-private-key-in-diff` | security | PEM private-key block in diff |
| `no-unpinned-github-action-ref` | security | `uses: action@mutable-ref` |
| `require-transaction-rollback-on-failure` | reliability | SQL without rollback handling |
| `no-process-exit-in-server-code` | reliability | `process.exit` in server JS/TS |
| `no-hardcoded-localhost-url-in-diff` | reliability | Hardcoded localhost URL |
| `require-lockfile-update-with-manifest-change` | reliability | Manifest change without lockfile (multi-file) |
| `no-unindexed-schema-migration-on-large-tables` | data | Migration index gap on large tables |
| `no-destructive-sql-without-guard` | data | Destructive SQL without guard |
| `require-where-on-delete-update` | data | `DELETE`/`UPDATE` without `WHERE` |
| `no-destructive-migration-without-backup-verification` | data | Destructive migration without backup ref (v1.2.0 addition) |
| `require-retry-with-backoff-for-transient-failures` | reliability | `.catch()` re-invocation with no delay (v1.3.0 addition) |
| `no-n-plus-one-queries-in-api-resolvers` | performance | N+1 query pattern in resolvers |
| `require-dataloader-or-eager-load-for-nested-fetches` | performance | Nested fetch without dataloader/eager load |
| `no-unbounded-list-query-without-pagination` | performance | List route/query without pagination |
| `no-sync-io-in-route-handler` | performance | Sync I/O in request-serving files |
| `require-strict-equality` | correctness | Loose `==` (`== null` allowed) |
| `no-var-instead-of-let-const` | style (advisory, never blocks) | `var` declarations |
| `no-console-log-in-server-diff` | style (advisory, never blocks) | `console.log` in server diff (`error`/`warn` allowed) |
| `no-swallowed-exceptions-in-critical-path` | — (in no pack) | Empty `catch` in any JS/TS (over-broad, excluded) |

Style severities never block (`BLOCKING_SEVERITIES` = security,
reliability, correctness, data, performance).

### `bin/sentinel.js` — CLI surface

Commands (verified via `bin/sentinel.js --help`): `review`
(`--pr` | `--diff`, `--format human|json|sarif|gov`,
`--rule-pack 1.0.0|1.1.0|1.2.0|1.3.0`, `--policy`, `--override
SHIP|DO_NOT_SHIP` + `--override-reason`, `--source`, `--ledger-path`,
`--no-ledger`, `--config`, `--memory-path`), `serve` (`--port 8787`,
`--host 127.0.0.1`, `--repo`, `--token`, `--ledger-path`,
`--memory-path`, `--config`, `--topology`, `--org-state`,
`--evidence-store`, `--org-store`), `resolve`, `verify`, `verify run`.
Exit codes: 0 SHIP / VALID, 1 DO_NOT_SHIP / INVALID / usage error,
2 STALE (re-run, never treat as failure).

### `console/server.js` — display-only API over `lib/` verdicts

Exports `createConsoleServer(opts)` (plugs into `node:http`) and
`listen(handler, { port, host })`, plus `createRateLimiter`.
The console presents; `lib/` decides. Spec: `docs/console-v1-design.md`.

Route table (all verified in code; `PUT /api/config` included):

| Method + path | Handler reads |
|---|---|
| `GET /api/healthz` | `{ok, version, pack}` (auth-exempt, rate-limit-exempt) |
| `GET /api/repos` (`?org=`) | Repo rows: `--repo` flags ∪ ledger ∪ topology |
| `GET /api/orgs` | `{orgs: [{id, name}]}`; 404 without `--org-store` |
| `GET /api/orgs/:id/repos` | Linked-repo rows; 400 malformed id, 404 unknown (never 403) |
| `GET /api/ledger?repo=&pr=` | Receipt chain for repo+PR |
| `POST /api/review` | `analyzeDiff` → verdict + receipt (200 carries STALE too) |
| `POST /api/resolve` | `resolveFinding` → resolution record |
| `POST /api/verify` | `verifyReceipt` → `{valid, reason?}` |
| `POST /api/verify/start` | `planChecks` → `PENDING` run (max 500 kept, lost on restart) |
| `GET /api/verify/:id` | Run view + evidence refs |
| `POST /api/verify/:id/complete` | Operator-asserted outcomes → `completeRun`; 409 if already complete |
| `GET /api/overview` (`?org=`) | Display roll-up over ledger + topology |
| `GET /api/health/verdicts` | Totals + top blocking rules from ledger |
| `GET /api/ledger/verify` | `verifyReceipt` per receipt + `prev_receipt_id` linkage |
| `GET /api/pr/:repo/:pr` (`?head=`) | PR-detail record; `stale` = head-drift vs `?head=` |
| `GET /api/finding/:repo/:pr/:rule/:line` | Finding detail + per-receipt history |
| `GET /api/rules` | `{pack, rules: [{id, severity, blocks}]}` |
| `GET /api/config` / `PUT /api/config` | Read / fail-closed write of `sentinel.config.json` |

### `mcp/sentinel-mcp.js` — 14 read-only tools, JSON-RPC 2.0 over stdio

Tools never write code, approve, or push. Pinned at 14 by
`test/mcp-health.test.mjs` (`TOOLS.length === 14`) and `docs/mcp.md`:

1. `sentinel_review` — diff/PR → SHIP/DO_NOT_SHIP verdict
2. `sentinel_rules_list` — rule ids + severities + blocking flags
3. `sentinel_verdict_latest` — latest ledger receipt for repo+PR
4. `sentinel_receipt_verify` — offline receipt hash check
5. `sentinel_config_show` — read/validate config (read-only)
6. `sentinel_finding_lifecycle` — list/validate `verification_state` transitions
7. `sentinel_verify_plan` — `planChecks` without executing
8. `sentinel_policy_evaluate` — parse + scope + evaluate a policy
9. `sentinel_orgs_list` — orgs in a store file
10. `sentinel_org_repos` — repos for one org
11. `sentinel_evidence_get` — one sealed item by id, hash-revalidated
12. `sentinel_evidence_verify` — `verifyAll` summary over a store
13. `sentinel_health_verdicts` — totals + top blocking rules from a ledger
14. `sentinel_ledger_verify` — hash-chain check via `lib/receipt.js`

### `apps/github/` — 8 files, transport only

`lib/` issues every verdict; these files only move it to GitHub.

| File | Contract |
|---|---|
| `apps/github/app.js` | Webhook → review → verdict card; owns exactly one top-level PR comment, update-in-place; no merges/approvals/pushes |
| `apps/github/verify.js` | `verifySignature(rawBody, signatureHeader, secret)` — HMAC-SHA256, `timingSafeEqual` |
| `apps/github/store.js` | File-backed installation registry keyed by `String(installationId)`; `handleInstallation` upserts idempotently + one `integration.changed` audit |
| `apps/github/flow.js` | `handlePullRequest`: `ingestPR` → injected `reviewFn` → `postCheck`; ingest runs before any API touch (fail closed, zero calls on bad SHA) |
| `apps/github/checks.js` | `postCheck` onto check run `sentinel/review`; key `${repo}#${prNumber}#${headSha}`; redelivery = `updateCheckRun`; new SHA = new run + `[STALE]`-prefix old (conclusion unchanged); unknown repo → `{ ignored: true }` |
| `apps/github/card.js` | Pure renderer; `CARD_MARKER = '<!-- sentinel-verdict -->'`; evidence sanitized (backticks stripped, 300 chars) |
| `apps/github/gh-client.js` | Production transport: `createGhClient` builds `{ createCheckRun, updateCheckRun }` on injected `exec` over `gh api` (argv array, no shell); token via `GH_TOKEN` env only |
| `apps/github/platform.js` | Minimal API client, injectable `fetch`; PAT mode or App mode (RS256 JWT via `node:crypto` → installation token exchange) |

### `bench/` + `policies/` + `scripts/`

- `bench/runner.js` — deterministic pack scoring over `bench/cases/*.json`; hit iff every expected rule fires AND no unexpected fires (strict; `strict: false` + `reason` = recall-only slot, none ship).
- `bench/report.js` — `renderMarkdown` + CLI writing `bench/results.json` + `bench/REPORT.md`; exit 0 always (scores are data).
- `bench/cases/` — **16 cases** covering all six severities + 4 clean negatives; 3 known true-positive overlaps expect both rules and stay strict.
- `policies/web-default.yaml` — sample `VerificationPolicy` for `review --policy`.
- `scripts/smoke.sh`, `scripts/console-smoke.sh` — boot + healthz + review smokes.

## 2. Data flows (ASCII)

### review → verdict (`lib/review.js`)

```
diff/PR --analyzeDiff--> findings --memory partition--> active findings
  --computeVerdict(blocking severities)--> SHIP | DO_NOT_SHIP
  --checkFreshness(HEAD/base moved?)--> STALE (no verdict, receipt kept)
  --makeReceipt + appendLedger--> receipt_id (sha256, deterministic)
  --format(human|json|sarif|gov)--> stdout (exit 0|1|2)
```

### finding → evidence → CONFIRMED (`lib/finding.js` + `verify` + `evidence` + `pipeline`)

```
createFinding --> HYPOTHESIS --transition(human)--> VERIFYING
planChecks(severity+ruleId) --> createRun --> startRun --> RUNNING
runLocal(repo copy @ targetSha) --> per-check EvidenceItem sealed (id=hash)
completeRun(results): all pass --> run PASS, finding stays VERIFYING-adjacent
  refuting check FAIL --> NOT_REPRODUCED | plain FAIL --> stays VERIFYING
  operator CONFIRMED path via console complete --> CONFIRMED (terminal)
attachEvidence: targetSha mismatch --> INVALID_VERIFICATION (throw, nothing stored)
DISMISSED reachable from any non-terminal (reason required, human only)
'ai' actor: confidence only, transitions throw
```

### webhook → check-run (`apps/github/`)

```
webhook --> verifySignature (reject = drop) --> handleInstallation (store upsert)
  --> ingestPR (SHA validation + repo gate; bad SHA throws, zero API calls)
  --> reviewFn({ diff, repo, prNumber, headSha, baseSha }) --> { verdict, ... }
  --> postCheck: first SHA --> createCheckRun(sentinel/review, completed)
                 redelivery --> updateCheckRun (idempotent)
                 new SHA    --> createCheckRun + supersede old ([STALE] title)
  --> renderCard --> upsert single PR comment (CARD_MARKER)
```

### console request path (`console/server.js`)

```
req --> rate-limit accounting (per-IP token bucket, counts ALL /api hits)
    --> auth gate: bad or missing credential --> 401 (takes precedence over 429;
          /api/healthz exempt; loopback exempt unless --no-exempt-loopback)
    --> 429 if limited --> route (table above; lib/ computes, console renders)
    --> static files (console/public PWA) for non-/api GET/HEAD
```

## 3. Test strategy map (46 suites, 414 tests)

`package.json` `test` script lists 44 files; `test/` contains exactly
those 44 (verified). Which file pins what:

- Rule correctness: `rules.test.mjs` (per-rule fixtures in `test/fixtures/`), `bench.test.mjs` (16 cases, recall = precision = 1), `memory-sarif.test.mjs` (memory + SARIF shape).
- CLI contract: `cli-contract.test.mjs` (pack sizes 6/20/21, formats, exit codes), `exact-head.test.mjs` (HEAD binding/STALE), `cli-policy.test.mjs`, `cli-orgstore.test.mjs`, `receipts.test.mjs`, `override.test.mjs`.
- Engine: `finding.test.mjs`, `evidence.test.mjs`, `evidence-store.test.mjs`, `verify.test.mjs`, `runner.test.mjs`, `pipeline.test.mjs`, `policy.test.mjs`, `policy-verdict.test.mjs`, `org-store.test.mjs`, `journey.test.mjs` (end-to-end).
- MCP: `mcp.test.mjs`, `mcp-extended.test.mjs`, `mcp-org.test.mjs`, `mcp-health.test.mjs` (pins `TOOLS.length === 14`).
- GitHub: `github-app.test.mjs`, `github-app-auth.test.mjs`, `github-install.test.mjs`, `github-ingest.test.mjs`, `github-checks.test.mjs`, `github-flow.test.mjs`, `github-ghclient.test.mjs`, `github-webhook.test.mjs`.
- Console: `console-api.test.mjs`, `console-equivalence.test.mjs` (UI ≡ CLI JSON), `console-topology.test.mjs`, `console-overview.test.mjs`, `console-pr.test.mjs`, `console-finding.test.mjs`, `console-verify.test.mjs`, `console-evidence.test.mjs`, `console-org.test.mjs`, `console-health.test.mjs`, `console-health-ui.test.mjs`, `console-complete.test.mjs`, `console-ratelimit.test.mjs`.

## 4. Extension guide

### Add a rule
1. Copy a `lib/rules/*.js` sibling (import `parseDiff` from `./_diff-parse.js`); scope by file path like siblings do (`SKIP_PATH_RE` for tests/fixtures).
2. Register id + severity in `SEVERITY_MAP` in `lib/rulepack.js`; add id to the target pack array (`V1_1_ADDITIONS` style — never edit `V1_0_IDS`, it locks determinism).
3. Add positive + negative fixtures under `test/fixtures/<rule-id>/`; add a case in `bench/cases/` (`expect` lists EVERY firing rule — strict).
4. Update `test/cli-contract.test.mjs` pack counts, `docs/rulepack-v1.2.md` (or new version doc), `bench/docs` score line in `docs/bench.md`.
5. Run `node bench/report.js` + `npm test`.

### New pack version
Bump `RULE_PACK_VERSION`, append to `SUPPORTED_PACKS`, add `RULE_IDS_BY_PACK` entry spreading the previous pack + additions. Touch every place that enumerates packs: `bin/sentinel.js --help`, MCP `rulePack`/`pack` descriptions (built from `SUPPORTED_PACKS`, automatic), `docs/mcp.md`, rulepack docs. Tests pinning counts: `cli-contract`, `console-api`, `console-ratelimit`, `mcp`, `receipts` (+1 gov row).

### Add an MCP tool
Append to `TOOLS` in `mcp/sentinel-mcp.js` (read-only; failures → `isError`, never throw), wire its handler in the tool dispatch. Then update `test/mcp-health.test.mjs` (`TOOLS.length`), `docs/mcp.md` (tool list + count line), and this file's tool list.

### Add a console route
Add the `method + path` branch in the `createConsoleServer` handler in `console/server.js` (after the token/rate gates, before the `/api/` 404 fallthrough); document it in the `docs/console-v1-design.md` §4 table and this file; add a `test/console-*.test.mjs` case (equivalence with CLI where it renders verdicts).

### Add a check type
Append to `CHECK_TYPES` in `lib/verify.js` (order matters — output is sorted by it), extend the severity/rule overlay in `planChecks`, update `docs/pipeline.md` and `test/verify.test.mjs` (closed-set pin: "8 expected types").

### Count-coupling traps (update all or tests go red)
- `TOOLS.length === 14` (`test/mcp-health.test.mjs`, `docs/mcp.md:35`).
- Pack sizes 6/20/21 (`test/cli-contract.test.mjs:19-21`); `/api/rules` length mirrors pack (`console-api`, `console-ratelimit`); gov rows = rules+1 (`receipts.test.mjs:196`).
- Suite list in `package.json` `test` script (44 files) must match `test/*.test.mjs` on disk.
- Bench 16 cases, recall = precision = 1 (`test/bench.test.mjs`, `docs/bench.md`).

## 5. External blockers (all manual — no agent action)

- **Docker**: no Dockerfile/compose in repo (verified: no references found); any containerized verify-runner work is manual environment setup.
- **GitHub App credentials**: App private key, installation-token exchange (`platform.js`), `GH_TOKEN` for `gh-client.js`, webhook secret for `verifySignature` — all provisioned outside the repo; never commit secrets.
- **PR #38**: named by task; no reference found anywhere in the repo — verify externally, manual.
- **Deploy / hosting**: `docs/cloudflare.md` path needs a Cloudflare account + zone + `cloudflared tunnel create` (manual); S9 BYOC deployment is `open` per `docs/roadmap-S0-S10.md`.
- **Billing**: contract phase 10 (commercial readiness: billing, plans, usage) is future work per `docs/SENTINEL-BUILD-CONTRACT.md` §10; nothing in the tree implements it.

## 6. Build-contract phase list (`docs/SENTINEL-BUILD-CONTRACT.md` §10)

0 Audit → 1 Foundation → 2 Marketing site → 3 GitHub vertical slice →
4 Review → 5 Verification → 6 Evidence + Verdict (first TRUE commercial
milestone) → 7 Fix loop → 8 Org controls → 9 Context graph + multi-repo →
10 Commercial readiness. Current tree covers 3–6 + 8 (org-store) slices.

