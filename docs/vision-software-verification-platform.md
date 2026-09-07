# Sentinel: Software Verification Platform — Product Vision (v1)

**Status:** owner vision, persisted 2026-09-07. Strategy input to roadmap;
not yet an approved build plan beyond the slices named in
`docs/roadmap-S0-S10.md`.
**Positioning:** Sentinel is a standalone category product —
*software verification platform* — by Aftergraph. A customer buys Sentinel
without ever hearing about WORKS, Trust Gateway, or AIE. Aftergraph is the
trust substrate underneath and the land-and-expand path upward.

> Understand every change. Verify the exact code. Prove what is safe to ship.

## The 8 surfaces (status)

| # | Surface | What | Status |
|---|---|---|---|
| 1 | Review | PR verdicts with cited evidence | CLI ships (pack v1.7.0); GitHub App implementation + mocked tests, no production proof |
| 2 | Verify | sandbox/test/build evidence behind verdicts | receipts+ledger ship; isolated local runner + evidence store ship (`lib/runner.js`, `lib/evidence-store.js`); hosted runners open |
| 3 | Security | secrets/deps/SAST/authN-Z/injection/crypto/exposure/config/IaC/supply-chain | 25-rule pack (security/reliability/data/performance/correctness) + red-team hardening; taint analysis, CVE/deps intel open; scanners delegated (gitleaks) |
| 4 | Context | repo + cross-repo system graph | not started |
| 5 | Fix | propose→patch→test→re-verify loop | **BLOCKED on decisions.md #4** (no auto-fix/approve) — proposal-only until owner reversal |
| 6 | Monitor | post-merge re-evaluation (deps, advisories, new rules) | not started |
| 7 | Control | dashboards: home, repo, org; policies; audit log | local console + PWA ships (`console/`, smoke PASS); hosted dashboard open |
| 8 | Intelligence | blast-radius/change graphs, incident tracing, product memory (FACT/POLICY/PREFERENCE/INFERENCE split) | not started |

One product, not eight sidebars: every surface reads the same
verdict/receipt/evidence objects defined here and in `docs/receipts-v0.1.md`.

## Planes (implementation view)

```text
CUSTOMER SURFACE (web / github-app / cli / api / mcp)
        CONTEXT PLANE (graph) │ INTELLIGENCE PLANE (hypotheses, never verdicts)
        VERIFICATION PLANE (sandbox runners; Complete ≠ Verified)
        EVIDENCE PLANE (EvidenceItem graph) → VERDICT ENGINE (deterministic)
```

Invariants (hard):

- Intelligence outputs are **hypotheses** (`finding_hypothesis` + location +
  claim; NO confidence-percent on verdicts — see conflicts).
- Only the verdict engine issues SHIP/DO_NOT_SHIP; LLM may explain, never judge.
- Runner invariant: requested SHA = checked-out SHA = tested SHA = verdict
  SHA, else `INVALID_VERIFICATION`.
- Child policy scopes attenuate (never widen) parent scopes.

## Verdict model

External: `SHIP | DO_NOT_SHIP | VERIFYING | STALE | BLOCKED`.
Internal adds: `PENDING ANALYZING REVIEWED VERIFYING BLOCKED VERIFIED
FAILED STALE OVERRIDDEN EXPIRED`. `BLOCKED` = required evidence missing
(adopted from this vision; maps to CLI exit 1 with `blocked` reason —
aligns with gov `failure`, documented in receipts doc when implemented).
Override is first-class: requester + reason + approver + expiry + audit
record — never silent.

## Finding lifecycle (not a comment)

`OPEN → (VERIFIED | DISMISSED-WITH-REASON | FIX-PROPOSED) → RESOLVED`,
with severity, owner, evidence refs, and history. Current CLI buckets
(blocking/silenced/advisory/excluded) are the v0 projection of this model.

## Metrics (never comment-count)

Verified Changes Shipped (north star), Cost Per Verified Change,
Time-to-Verified-Merge, blocking precision, FP rate, override rate,
stale-verdict rate, escape rate, verify latency. SentinelBench (public,
falsifiable: real PRs, known defects, FP controls) is the research-grade
expression — seeded by `prototype/precision-audit.md` discipline.

## Pricing (directional — [VERIFY] all tiers against first-party pages)

Outcome-aligned, not per-comment: Free (public + 1 private), Developer,
Team, Business, Enterprise (SSO, audit, regional), plus usage-metered
verification compute. Enterprise needs Private/BYOC (control-plane /
data-plane split) — table stakes vs Greptile/CodeRabbit enterprise.

## Aftergraph fit (loose coupling, §23 of vision)

Standalone Sentinel ships with internal authority/rules/jobs/evidence.
When connected: Trust Gateway leases authority, WORKS runs verification
missions, Governance compiles policies, shared evidence semantics. Same UX,
stronger backend. Sentinel is the verification vertical; upsell path is
Sentinel → Trust → WORKS → Governance.

## Conflicts with locked decisions (need owner call)

1. **Fix (#4):** vision's one-click fix (commit+PR) contradicts "no
   auto-fix/approve in MVP". Built slices stay proposal-only (patch as
   artifact, human applies) until Jonas reverses #4.
2. **Confidence % (#9):** `Confidence 96%` mock contradicts deterministic
   verdict path. Shipped alternative: evidence-completeness
   (required checks satisfied/total) — computed, never inferred. No
   probabilistic number may touch a verdict.
3. **Pricing tiers:** all figures [VERIFY] before any public page.
