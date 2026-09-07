# Roadmap S0–S10 — Sentinel build gates

**Rule:** a gate is done only when its exit criteria are observed, not
planned. S0–S3 must already feel like a finished commercial product, not
foundation work.

| Gate | Scope | Exit criteria | Status |
|---|---|---|---|
| S0 | Exact-HEAD local CLI | review/resolve/verify, 20-rule pack, receipts+ledger, `--diff` local mode, 74 green | DONE (pack v1.6.0: 25 rules, 461 green; `--diff` local mode ships) |
| S1 | GitHub App: review + verdict card | webhook verify, review-on-PR, card update-in-place, STALE on push, mocked tests green | IMPLEMENTED + mocked tests green (`apps/github/`); real install / webhook delivery unverified |
| S2 | Context graph, cross-file reasoning | symbol/call/test graph for JS/TS; finding shows blast radius | SHIPPED (uncommitted): engine + CLI/MCP blast-radius (`lib/context-graph.js`, `docs/context-graph.md`); review/console wiring; Python import-graph (static/conditional/dynamic, package resolution, zero cross-language edges); 2 held-out bench cases live; test/route nodes open |
| S3 | Verification runner + evidence items | isolated run of build/tests, evidence refs on verdict | DONE, local scope (`lib/runner.js`, `lib/pipeline.js`, `lib/evidence-store.js`, `verify-run` CLI; runner/verify/pipeline/journey tests green); hosted runners open |
| S4 | Fix loop + re-verification | patch artifact → tests → new verdict | BLOCKED on decisions #4 |
| S5 | Org policies, analytics, multi-repo | policy files, org board, console | PARTIAL: console BUILT local (`console/`, smoke PASS) + policies ship (`lib/policy.js`, `--policy`, MCP tools); analytics / multi-repo open |
| S6 | Security depth | taint/path analysis, runtime exploit-attempt evidence | pack v1.6.0: 25 deterministic rules (security/reliability/data/performance/correctness) + red-team hardening + adversarial suite; taint analysis, CVE/deps intel, runtime exploit evidence open |
| S7 | Deployment verification | source→artifact→runtime match proofs | open |
| S8 | Production feedback | incident→change tracing, regression proposals | open |
| S9 | Private/BYOC deployment | control/data-plane split, regional | open |
| S10 | Full Aftergraph integration | TG leases, WORKS missions, Governance compile | open |

Adjacent tracks (no gate dependency): read-only MCP server (agent loops),
SentinelBench harness, Cloudflare hosting per `docs/cloudflare.md`.

MCP ships in-tree (`mcp/sentinel-mcp.js`); S1 ships implementation+mocks
(`apps/github/`). No history is rewritten to get there.
