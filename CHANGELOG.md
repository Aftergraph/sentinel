# Changelog

All entries are derived verbatim from `git log` subjects on `main`
(first-parent), each traceable to its short commit hash. No invented items.
Rule-pack versions (`lib/rulepack.js` `RULE_PACK_VERSION`) are tracked
separately from this package version and are noted where the single
commits that bumped them landed.

## [0.1.0] - 2026-09-07

- feat(sentinel): parser hardening, tracing, arch map (`1a8692b`)
- feat(sentinel): rate limiting, wave-12 docs (`8173768`)
- feat(sentinel): run completion, webhook gap tests (`4ee24aa`)
- docs(sentinel): wave-9/10 surfaces (health, flow, org flag, MCP+2) (`b0a9df0`)
- feat(sentinel): health UI, org-store flag, MCP health tools (`2fbc7bb`)
- feat(sentinel): health routes, github flow E2E, wave-8 docs (`69959f6`)
- feat(sentinel): evidence wiring, override, MCP org tools (`da4ec4b`)
- feat(sentinel): evidence store, journey E2E, docs-sync (`90601ab`)
- feat(sentinel): CLI policy/verify-run, MCP judge tools, org console (`1fadb88`)
- feat(sentinel): pipeline E2E, policy verdict gate, org store (`be858bb`)
- feat(sentinel): policy engine, gh prod client, verify view (`aae1cb2`)
- feat(sentinel): runner isolation, github checks, finding detail (`04fde91`)
- feat(sentinel): engine S3 verify-wiring, github ingest, cockpit PR view (`05b1cac`)
- feat(sentinel): engine S1+S2, github install, cockpit overview (`29c136a`)
- merge origin/main (rules #2/#3) + rule-pack v1.2.0 (`70628b5`)
  - Merged branch heads: rule 13
    no-destructive-migration-without-backup-verification (`7083d09`) and
    rule 7 no-swallowed-exceptions-in-critical-path (`c28df81`).
- feat(sentinel): fullstack v1 batch — local review, console, MCP, App slice, bench (`67fa500`)
- feat(sentinel): v0.1 governance-registered review (receipts, gov surface, delta, config) (`557171d`)
- feat(sentinel): CLI v0 contract + rule-pack v1.1.0 (6→20 rules) (`d1cf736`)
- feat(sentinel): exact-head freshness gate covers HEAD movement (#1) (`6ac367d`)
- merge(prototype/livefire-proofs): live exit-1 and STALE proofs (`9439d36`)
- merge(prototype/dogfood-results): dogfood 2/5 with root causes (`4b0007c`)
- merge(feat/memory-sarif): resolution memory and SARIF output (`c946d46`)
- docs(sentinel): final 6-rule pack per precision audit (`d364544`)
- merge(feat/v0-rules): v0 6-rule pack with fixtures and tests (`6240415`)
- merge(feat/cli-scaffold): minimal review plumbing (`beececf`)
- merge(prototype/precision-audit): 6 KEEP / 4 CUT (`aeb0f92`)
- docs(sentinel): lock decision #9 (deterministic v0 verdict path, no LLM judge) (`37d900c`)
- docs(sentinel): standards alignment for CLI v0 (SARIF, gitleaks, exit codes, determinism) (`c2126e0`)
- docs(sentinel): CLI v0 feature definitions (F-01..F-08) (`bd73a01`)
- docs(sentinel): CLI v0 product design (command contract, rule-pack, memory) (`c3ebedd`)
- merge(prototype/5pr-validation): prototype sprint wave 2 (`9955840`)
- merge(prototype/landing-draft): prototype sprint wave 1 (`b794062`)
- merge(prototype/rule-gap-list): prototype sprint wave 1 (`aecbdb3`)
- merge(prototype/cli-output-mock): prototype sprint wave 1 (`63eed64`)
- merge(prototype/verdict-card-mock): prototype sprint wave 1 (`9d2a4b9`)
- docs(sentinel): foundation strategy docs (product core, wedge, roadmap) (`66b23a5`)
