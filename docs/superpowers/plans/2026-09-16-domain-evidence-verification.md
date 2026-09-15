# Domain Evidence Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independent Sentinel verification path for operational domain evidence, then prove Rendetalje reconciliation evidence can be verified without conflating reconciliation with verification.

**Architecture:** Sentinel gets a separate `lib/domain-verification.js` path that reuses canonical hashing but not the code-review Finding state machine. Rendetalje projects its reconciliation payload into the new envelope shape without importing Sentinel as an execution dependency. A sandbox-only cross-repo sensor proves VERIFIED and INDETERMINATE semantics.

**Tech Stack:** Node.js ESM, node:test, TypeScript/Vitest in Rendetalje, existing Sentinel canonical JSON/SHA-256 primitives.

**Spec:** `docs/superpowers/specs/2026-09-16-domain-evidence-verification-design.md`

## Global Constraints

- Existing `lib/verify.js` behavior must remain unchanged.
- Sentinel may verify but never approve, dispatch, grant authority, mutate business state or execute providers.
- `RECONCILED` is not `VERIFIED`.
- VERIFIED requires a Sentinel-owned independent check with `observerRef !== executorRef`.
- No production endpoints or credentials in tests/sensors.
- Every implementation task follows RED → GREEN → full relevant regression → signed commit.

---
### Task 1: Sentinel domain envelope integrity and subject correlation

**Files:**
- Create: `lib/domain-verification.js`
- Create: `test/domain-verification.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `verifyDomainEvidence({ envelope, independentCheck, verifierRef, now })`
- Produces: verdict constants `VERIFIED`, `REJECTED`, `INDETERMINATE`
- Reuses: `canonicalJson` and `hashBody` from `lib/evidence.js`

- [ ] **Step 1: Write failing tests** for malformed schema, digest tampering, subject/body mismatch and structurally valid evidence without an independent checker.
- [ ] **Step 2: Run** `node --test test/domain-verification.test.mjs` and verify RED because `lib/domain-verification.js` is missing.
- [ ] **Step 3: Implement minimal envelope validation** with schema `aftergraph.domain-evidence/1.0`, SHA-256 recomputation and exact subject correlation.
- [ ] **Step 4: Return `REJECTED`** for integrity/correlation failures and `INDETERMINATE` when independent evidence is unavailable.
- [ ] **Step 5: Run targeted tests** until GREEN, then add the test file to `npm test`.
- [ ] **Step 6: Commit** `feat(verification): add domain evidence integrity gate`.
### Task 2: Sentinel independent check and verification receipt

**Files:**
- Modify: `lib/domain-verification.js`
- Modify: `test/domain-verification.test.mjs`

**Interfaces:**
- Consumes: validated `aftergraph.domain-evidence/1.0` envelope from Task 1.
- Consumes: `independentCheck({ subject, evidence }) -> Promise<{status, observerRef, evidenceRefs}>`.
- Produces: `aftergraph.domain-verification.receipt/1.0` with content-addressed `receiptId`.

- [ ] **Step 1: Add failing tests** for independent PASS → VERIFIED, FAIL → REJECTED, unavailable/throwing/same-observer → INDETERMINATE.
- [ ] **Step 2: Run targeted tests** and verify RED on missing independent-check semantics.
- [ ] **Step 3: Implement deterministic check ordering**: `EVIDENCE_INTEGRITY`, `SUBJECT_CORRELATION`, `INDEPENDENT_READBACK`.
- [ ] **Step 4: Implement verdict precedence** `REJECTED > INDETERMINATE > VERIFIED` and enforce `observerRef !== executorRef`.
- [ ] **Step 5: Seal a receipt** using `hashBody` over the receipt body; set `receiptId = "dvr_" + receiptDigestSha256`.
- [ ] **Step 6: Run targeted + full `npm test`** and commit `feat(verification): issue domain verification receipts`.
### Task 3: Rendetalje domain evidence envelope projection

**Files (Rendetalje repo):**
- Create: `src/platform/domain-verification.ts`
- Create: `tests/domain-verification-envelope.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: the exact reconciliation input/result used by `reconcileGovernedEffect(...)`.
- Produces: `projectDomainEvidenceEnvelope(...)` returning schema `aftergraph.domain-evidence/1.0`.
- Does not import Sentinel or perform network I/O.

- [ ] **Step 1: Create an isolated Rendetalje worktree** from current `origin/main`.
- [ ] **Step 2: Write failing tests** asserting exact tenant/mission/effect/idempotency/executor correlation and digest equality with the reconciliation evidence body.
- [ ] **Step 3: Run targeted tests** and verify RED because the projection does not exist.
- [ ] **Step 4: Implement the pure projection** and export it from `src/index.ts`.
- [ ] **Step 5: Add negative tests** for non-RECONCILED input, digest mismatch and foreign tenant.
- [ ] **Step 6: Run `npm run verify`, `npm run verify:platform`, and `npm audit --omit=dev`**.
- [ ] **Step 7: Commit** `feat(platform): project domain verification evidence`.
### Task 4: Cross-repo independent-verification sandbox sensor

**Files (Rendetalje repo):**
- Create: `scripts/verify-domain-verification-e2e.mjs`
- Modify: `package.json`
- Modify: `tests/package-contract.test.ts`

**Interfaces:**
- Consumes: Rendetalje `projectDomainEvidenceEnvelope(...)` from Task 3.
- Consumes: Sentinel `verifyDomainEvidence(...)` from Tasks 1-2 through `SENTINEL_ROOT`.
- Produces: machine-readable sandbox proof with `VERIFIED`, `INDETERMINATE`, `receiptId`, and no `authorityGranted`/provider credentials.

- [ ] **Step 1: Write a failing package-contract test** requiring `verify:domain-e2e`.
- [ ] **Step 2: Implement a loopback-only independent read-back mock** owned by the verifier harness, with ephemeral tokens and temp state.
- [ ] **Step 3: Assert positive path**: independently matching read-back → Sentinel `VERIFIED`.
- [ ] **Step 4: Assert negative independence path**: identical reconciled envelope without independent checker → `INDETERMINATE`.
- [ ] **Step 5: Assert tampered evidence path** → `REJECTED`.
- [ ] **Step 6: Run full Rendetalje verification plus the new sensor**; worktree must remain clean except intended source changes.
- [ ] **Step 7: Commit** `test(platform): prove independent domain verification`.
### Task 5: Final review and boundary documentation

**Files:**
- Modify: Sentinel `README.md` or focused verification docs only if needed for discoverability.
- Review: all commits from Tasks 1-4.

**Interfaces:**
- No new runtime interface beyond Tasks 1-4.
- Produces exact-head verification evidence and PR-ready summaries for both repos.

- [ ] **Step 1: Run Sentinel full `npm test`** on exact feature head.
- [ ] **Step 2: Run Rendetalje full verify/platform/audit + both governed sensors** on exact feature head.
- [ ] **Step 3: Run `git diff --check` and confirm no generated runtime state remains.**
- [ ] **Step 4: Run independent exact-patch review for Sentinel authority/verification semantics.**
- [ ] **Step 5: Run independent exact-patch review for Rendetalje projection/sensor semantics.**
- [ ] **Step 6: Open narrow PRs with exact-head evidence. Merge only with head-SHA guards and repository rules.**
- [ ] **Step 7: Fresh-verify merged mains and record that production provider verification remains out of scope.**

## Pre-flight self-review

- Spec coverage: Tasks 1-4 cover all eight acceptance criteria; Task 5 covers release evidence.
- Placeholder scan: no TBD/TODO/"implement later" steps.
- Type consistency: `aftergraph.domain-evidence/1.0`, `verifyDomainEvidence`, verdict names and receipt schema are identical across tasks.
- Shared-file conflicts: Sentinel Tasks 1-2 intentionally serialize on `lib/domain-verification.js`; Rendetalje Tasks 3-4 serialize on package/index surfaces. Sentinel and Rendetalje implementation can proceed in separate worktrees once the contract above is frozen.
