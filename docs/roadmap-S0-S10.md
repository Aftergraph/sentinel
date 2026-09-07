# Roadmap S0–S10 — Sentinel build gates

**Rule:** a gate is done only when its exit criteria are observed, not
planned. S0–S3 must already feel like a finished commercial product, not
foundation work.

| Gate | Scope | Exit criteria | Status |
|---|---|---|---|
| S0 | Exact-HEAD local CLI | review/resolve/verify, 20-rule pack, receipts+ledger, `--diff` local mode, 74 green | DONE (v0.1.0; `--diff` uncommitted) |
| S1 | GitHub App: review + verdict card | webhook verify, review-on-PR, card update-in-place, STALE on push, mocked tests green | STARTED (`apps/github/`, mocked platform client) |
| S2 | Context graph, cross-file reasoning | symbol/call/test graph for JS/TS; finding shows blast radius | not started |
| S3 | Verification runner + evidence items | isolated run of build/tests, evidence refs on verdict | not started |
| S4 | Fix loop + re-verification | patch artifact → tests → new verdict | BLOCKED on decisions #4 |
| S5 | Org policies, analytics, multi-repo | policy files, org board, console | console spec approved |
| S6 | Security depth | taint/path analysis, runtime exploit-attempt evidence | 6 rules ship; rest open |
| S7 | Deployment verification | source→artifact→runtime match proofs | open |
| S8 | Production feedback | incident→change tracing, regression proposals | open |
| S9 | Private/BYOC deployment | control/data-plane split, regional | open |
| S10 | Full Aftergraph integration | TG leases, WORKS missions, Governance compile | open |

Adjacent tracks (no gate dependency): read-only MCP server (agent loops),
SentinelBench harness, Cloudflare hosting per `docs/cloudflare.md`.

MCP and S1 slices land uncommitted until owner review; no history is
rewritten to get there.
