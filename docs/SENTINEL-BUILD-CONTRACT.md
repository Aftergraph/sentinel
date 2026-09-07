# SENTINEL-BUILD-CONTRACT — product + engineering contract

Authority: repo reality first. This document loses to `git log`, tests, and
running code. Preserve good existing work; extend, don't rewrite.

## 1. Mission

Build **Sentinel by Aftergraph** into a commercial-grade software
verification platform (CodeRabbit/Greptile/Aikido league) with the
differentiator: **a verdict is bound to the exact commit and backed by
reproducible evidence.** Standalone product; seams (not dependencies)
toward WORKS / Trust Gateway / Governance / Evidence / Research.

Non-negotiable invariants:

```text
Reviewed != Verified | Finding != Fact | Agent output != Verdict authority
Complete != Verified
```

## 2. Verdict authority

Coding models may create findings, suggest fixes, propose verification.
A model MUST NOT issue `SHIP`. Only the deterministic verdict engine —
policy over exact-HEAD evidence — issues SHIP / DO_NOT_SHIP.

```text
currentHead !== verifiedHead        → STALE (never silently green)
requiredEvidenceMissing             → BLOCKED
blockingVerifiedFinding / checkFail → DO_NOT_SHIP
allRequiredGatesSatisfied           → SHIP
```

Verdict states (internal): PENDING ANALYZING REVIEWED VERIFYING BLOCKED
VERIFIED FAILED STALE OVERRIDDEN EXPIRED. Customer-facing: SHIP,
DO_NOT_SHIP, VERIFYING, STALE, BLOCKED.

## 3. First commercial journey (vertical slice first)

```text
visit → GitHub sign-in → install App → select repo → discovery/index →
PR opened/updated → exact HEAD captured → analyzed → findings →
required checks → evidence → verdict → GitHub Check updated.
HEAD moves after verification → STALE.
```

Surface priority: marketing site → web app → GitHub integration →
review engine → verification runner → evidence → verdict → CLI/MCP
(CLI/MCP already exist — keep them working, extend last).

## 4. Repo reality (2026-09-07, verified)

```text
sentinel/  (zero-dep Node ≥20, suite: npm test, 128 pass)
├── bin/sentinel.js        CLI v0 (review/pr/diff/verify/receipts/serve)
├── lib/review.js          verdict core: analyzeDiff/computeVerdict/freshness/delta/config
├── lib/rulepack.js        RULE_PACK_VERSION=1.2.0, 21 deterministic rules, pinned packs
├── lib/receipt.js         local claim log (NOT L1/L2 evidence)
├── console/               zero-dep server + vanilla PWA (6 views) + v1b topology import
├── mcp/sentinel-mcp.js    read-only stdio judge (review/rules/verdict/verify/config)
├── apps/github/app.js     webhook verify, verdict card, STALE on drift, App-JWT auth
├── bench/                 16-case falsifiable harness, recall/precision 1.0
└── docs/                  vision, S0-S10 roadmap, decisions, receipts contract
```

aftergraph.org (separate repo, PR #38 open): marketing site target
(`sentinel.aftergraph.org` experience + `/demo` + `/security`).

## 5. Domain minimum (tenant-scoped everywhere)

Organization Workspace User Membership Repository Branch Commit
PullRequest Review Finding(finding: HYPOTHESIS→VERIFYING→
CONFIRMED|NOT_REPRODUCED|INDETERMINATE|DISMISSED) VerificationRun
VerificationCheck EvidenceItem(immutable after seal, content-hashed)
Policy+PolicyVersion Verdict Integration AuditEvent.

Finding keeps AI confidence SEPARATE from verification_state.
Evidence: id, run_id, target_sha, type, source, runner_identity, command,
env, started/completed, exit_code, result, stdout/stderr/artifact refs,
output_hash. Jobs idempotent; runners isolated (exact-SHA checkout,
verified SHA, bounded CPU/mem/net, secret hygiene, cleanup).

## 6. Policy + audit

Policy hierarchy Organization→Workspace→Repository→Path, versioned YAML;
every verdict references exact policy version. Audit every consequential
action: repo.connected/indexed, pr.opened/updated, review/verification
started/completed, finding lifecycle, verdict issued/invalidated/
overridden, policy.updated, integration.changed.

## 7. Brand: Verification Intelligence (condensed)

Aftergraph DNA + Linear-level precision + tool density. NOT generic
cyber/neon-shield. Mark: geometric verification gate/checkpoint (◈-like),
"SENTINEL by Aftergraph" (Aftergraph secondary).

Base: bg #080B12, elevated #0D111B, surface #111724, border
rgba(255,255,255,.08), text #F5F7FA, secondary #8C96A8.

```text
PURPLE = AI thinks | CYAN = system observed | GREEN = verified
AMBER = attention | RED = blocked | muted orange = STALE | gray = unknown
```

AI inference and verified fact NEVER share color (brand law, marketing +
app). Type: grotesk display (Geist/Inter-like), dense 12–15px dashboards,
64–80px marketing headlines. Radius: cards 8–12, buttons 6–8, chips full.
Monoline technical icons. Motion is functional only (verdict transitions,
STALE flip, evidence attach) — no ambient aurora.

Hero copy: **"Ship code you can prove works."** / "Sentinel reviews,
tests and verifies every change against the exact commit you intend to
merge." CTAs: Start free / See a verified PR. Hero visual: a LIVE PR
card (PR #482, HEAD 98af672, DO_NOT_SHIP, 2 blockers / 18 checks /
11 evidence, one HIGH finding with ✓ reproduced / regression test /
API captured), animating Analyzing→Finding→Reproducing→Evidence→verdict.
Trust line: "No training on your private code. Cloud or self-hosted."

Further pages: /demo (real interactive PR #142 payments-api, no signup:
diff→finding→graph→verification→evidence→verdict), /security trust
center (data flow, retention, providers, training policy, encryption,
tenant isolation, private runners, self-hosting, subprocessors, audit
logs, deletion — build early, with data-flow diagram), pricing
(Developer/Team/Business/Enterprise + compute meter; "Contact
engineering", not sales-gating devs), docs (Getting Started, GitHub,
CLI, MCP, Reviews→Policies, Security, Enterprise, API/Webhooks/SDK),
/research (Complete≠Verified, evidence gating, MISSION-Bench — Aftergraph
depth lives here, not on the homepage).

App shell (information density is a feature): nav Overview Changes
Findings Verify Security | Repos Evidence Policies Analytics |
Integrations Settings. Overview: Engineering confidence %, Open/Blocked/
Stale/Critical cards, Needs-attention queue, Recent verdicts,
Verification health. PR view tabs: Overview Findings Diff Context
Verification Evidence Activity; header PR# + title + verdict + HEAD.
Finding detail: severity, confidence (AI) vs VERIFIED status, why/blast
radius/evidence/files/fix/history. Verification: run VR-####, target SHA,
progress n/m, per-check states + live evidence stream. Evidence graph:
SHIP→Policy/Verify→Rule/Tests/Build→Artifacts→SHA, clickable nodes.

## 8. Budgets + a11y + tests

Frontend: no layout shift, all breakpoints, keyboard, reduced-motion,
fast nav, progressive loading. Backend: idempotent webhooks, bounded
retries, structured logs, trace ids, tenant isolation, safe cancel.
Verification: hard timeouts, resource limits, exact-SHA validation.
A11y: keyboard/semantic/focus/contrast/reduced-motion, never color-only
(icon + label + text). Tests: unit/integration/contract/E2E/security/
migration/failure-injection. Invariant tests: HEAD change kills verdict;
LLM cannot SHIP; missing evidence BLOCKED; failed check DO_NOT_SHIP;
tenant isolation; webhook idempotence; SHA mismatch rejects run;
override → audit event.

## 9. Working rules for agents

- Small verified slices; acceptance gates per phase; never claim done
  on files-added. Report EXACT HEAD + delivered + tests/build/E2E/
  security + screenshots reviewed + limits + NOT delivered + next slice.
- Run tests/typecheck/lint/build/E2E + failure paths; fix regressions
  before advancing. Inspect rendered UI at desktop/tablet/mobile.
- Reuse product components across marketing demo and app.
- NEVER fabricate integrations, customers, benchmarks, compliance
  claims (decisions #8). Pricing/claims marked [VERIFY] until confirmed.
- Deterministic verdict path stays LLM-free (decisions #9). No auto-fix
  in user-facing loops (decisions #4).
- Parallel agents only on genuinely independent paths; isolated
  worktrees when writing concurrently.
- Commit discipline: sentinel direct-on-main per session instruction;
  aftergraph.org via PRs. Leave work uncommitted only until told.

## 10. Phase order

0 Audit (reality, gaps, assets, risks, order) → 1 Foundation (monorepo
shape only if justified, domain package, schema, auth/tenant shell,
events/audit primitives, design system, app shell, CI, test baseline) →
2 Marketing site → 3 GitHub vertical slice (OAuth/App, install, webhooks,
SHA capture, Check, idempotence, STALE) → 4 Review (diff ingest, context,
pipeline, normalize, dedupe, UI, comments) → 5 Verification (planner,
isolated runner, checks, progress, timeouts, artifacts) → 6 Evidence +
Verdict (first TRUE commercial milestone: SHIP/DO_NOT_SHIP/BLOCKED/STALE/
missing-evidence/SHA-mismatch paths) → 7 Fix loop (patch→isolated
apply→regression test→re-verify→NEW head→NEW verdict) → 8 Org controls →
9 Context graph + multi-repo → 10 Commercial readiness (billing, plans,
usage, email/Slack, onboarding, analytics, trust center, retention,
deletion, support, enterprise hooks).

Homepage order: NAV → HERO → LIVE PR DEMO → social proof (factual
integrations first, no fake logos) → "Review is not verification." →
UNDERSTAND / REVIEW / VERIFY pillars → scroll workflow
(CHANGE→UNDERSTAND→REVIEW→VERIFY→PROVE→SHIP, one PR transforming) →
" A verdict expires when the code changes." (SHIP→STALE on push) →
Evidence Explorer (Evidence/Logs/Tests/Policy/Artifacts/Trace tabs,
Finding→Check→Evidence→Verdict chain) → agent loop ("Let agents write.
Let Sentinel decide.", Codex/Claude/Cursor/Devin chips) → Security+Quality
("one verdict") → quiet comparison table (category, never Competitor❌) →
Enterprise (policy inheritance visual) → results (real only) → pricing
teaser → "Verify your first PR."
