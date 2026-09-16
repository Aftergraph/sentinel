# Sentinel Evidence Status

**Evidence cut:** 2026-09-08  
**Repository baseline:** `main@c09eb714ea3e5ff8449e8c4059826ed156bb307c`  
**Current rule-pack source of truth:** `lib/rulepack.js` — v1.7.0, 26 deterministic rules.

This document exists to stop three different things from being collapsed into one flattering number. Human prototype scoring, historical CLI dogfood, and live CLI proofs answer different questions.

## Evidence classes

| Artifact | What it supports | What it does **not** support |
|---|---|---|
| `prototype/5pr-validation.md` | A manually reasoned five-PR baseline: expected verdicts, file/line rationale and a stale scenario. | It is not a measured Sentinel CLI accuracy result. The 15/15 score is human-scored prototype acceptance, not current rule-pack performance. |
| `prototype/dogfood-results.md` | A real CLI replay using the original six-rule pack. It matched 2/5 historical expected verdicts and documented why the other three missed. | It does not measure v1.7.0. It must not be quoted as current Sentinel accuracy. |
| `prototype/livefire-results.md` | Real CLI proof at Sentinel HEAD `4b0007c` that exit 1 (`DO_NOT_SHIP`) and exit 2 (`STALE`) could be produced under the documented setup. | It is not an exact-current-HEAD proof and it is not a broad precision/recall benchmark. |
| `lib/rulepack.js` | Current deterministic rule inventory and blocking semantics. v1.7.0 contains 26 rules. | Rule count is not evidence of review quality, recall or auditor acceptability. |

## Current verified implementation state

Repository source currently contains:

- CLI review bound to a PR/head with `SHIP`, `DO_NOT_SHIP` and `STALE` exit semantics;
- rule-pack registry v1.7.0 with 26 deterministic rules;
- content-addressed review receipts and offline receipt verification;
- policy-scoped review and explicit override semantics;
- isolated `verify run` execution and sealed evidence paths;
- read-only MCP surfaces;
- GitHub App/webhook code and verdict-card transport;
- local console and context/blast-radius surfaces.

These are implementation claims only. Each stronger claim still needs its own execution evidence.

## Open evidence gates

### E1 — Current-pack five-PR replay

Re-run the five historical PR cases using **v1.7.0**, not the six-rule historical pack.

For each run record:

- Sentinel exact HEAD;
- rule-pack version;
- target repository and PR number;
- target PR exact head/base SHAs;
- command and exit code;
- machine output / receipt id;
- findings with file/line evidence;
- whether the historical expected verdict is still applicable.

The stale case must not be treated as a normal static replay: staleness is a transient state. Reproduce it with a controlled base-move setup or mark it `NOT_REPRODUCED`.

### E2 — Current-HEAD exit semantics

Repeat the live-fire proofs against the current Sentinel HEAD for:

- exit 0 / `SHIP`;
- exit 1 / `DO_NOT_SHIP` with an in-pack deterministic violation;
- exit 2 / `STALE` with a controlled mid-review base movement.

A historical proof remains useful, but it cannot silently become proof of a later implementation.

### E3 — Precision / false-positive corpus

The rule-pack precision audit explains why rules were admitted or excluded. The next empirical gate is a pinned corpus with expected labels and per-rule false-positive accounting. Report both false positives and misses. A single aggregate accuracy number is insufficient.

### E4 — GitHub App live delivery

Mocked webhook/check-run tests prove code paths, not installation behavior. Before claiming the GitHub App as production-ready, capture a real installation/webhook delivery against an exact PR head, including signature verification, duplicate-delivery handling, stale invalidation and resulting check/verdict state.

### E5 — Auditor / governance acceptability

The repository has receipt, ledger, override and evidence mechanics. Auditor acceptability remains unproven until the retention, immutability, export and override model is reviewed against an explicit audit scenario.

## Claim rules

Use these labels when describing Sentinel:

- **Implemented** — source exists and is mechanically testable.
- **Tested** — the stated automated/local test passed at an exact version.
- **Live-proven** — an external service/runtime interaction was observed and recorded at an exact version.
- **Validated on corpus** — a pinned corpus was evaluated with disclosed scoring and misses.
- **Production-ready** — only after repository-defined release, operational and deployment gates pass.

Do not translate `implemented` into `validated`, or a historical proof into a current-head proof. Sentinel is supposed to punish that exact category error in everybody else's pull requests; it would be embarrassing to make it in its own README.
