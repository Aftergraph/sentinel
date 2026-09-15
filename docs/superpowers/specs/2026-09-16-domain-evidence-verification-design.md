# Domain Evidence Verification Design

## Status
Approved for implementation on 2026-09-16.

## Purpose
Sentinel needs an independent verification path for operational/domain outcomes without reusing the existing code-review `Finding + targetSha` state machine.

The new boundary verifies immutable domain evidence packages after execution and reconciliation. It does not approve work, grant authority, dispatch Runtime actions, execute providers, mutate business state, or replace WORKS/Trust/Business Ops ownership.

## Ownership
- Business Ops / tenant domains produce reconciliation evidence and a verification envelope.
- Trust Gateway owns approval and authority admission.
- Runtime owns orchestration.
- WORKS owns durable execution.
- Sentinel owns only independent verification verdicts and verification receipts.

## Non-goals
- No production provider connector in this slice.
- No migration of the existing code-review verifier.
- No generic workflow engine.
- No automatic authority escalation from a verification result.
- No claim that `RECONCILED` means `VERIFIED`.
## Canonical input contract

`aftergraph.domain-evidence/1.0` contains:

- `subject.tenantId`
- `subject.missionId`
- `subject.effectId`
- `subject.idempotencyKey`
- `subject.subjectRef`
- `subject.executorRef`
- `evidence.type`
- `evidence.sourceRef`
- `evidence.digestSha256`
- `evidence.observedAt`
- `evidence.body`
- `claims.reconciliationStatus`
- `claims.readback`
- `claims.eligibleForVerification`

The evidence digest MUST equal SHA-256 over Sentinel's canonical JSON representation of `evidence.body`. Subject correlation fields in the body MUST equal the envelope subject.

The first supported profile is `provider-effect-reconciliation/1.0`.
## Verification model

Sentinel evaluates three classes of checks:

1. `EVIDENCE_INTEGRITY` — recompute the evidence digest and reject tampering.
2. `SUBJECT_CORRELATION` — verify tenant, mission, effect, idempotency and subject bindings.
3. `INDEPENDENT_READBACK` — run a Sentinel-owned checker that observes the target independently of the executor.

The independent checker returns:

```js
{ status: 'PASS' | 'FAIL' | 'INDETERMINATE', observerRef, evidenceRefs: [] }
```

`observerRef` MUST be non-empty and MUST differ from `subject.executorRef`. A missing checker, missing observer, same observer/executor identity, timeout, or unavailable observation produces `INDETERMINATE`, not `VERIFIED`.
## Verdict semantics

Closed verdict set:

- `VERIFIED` — structural checks pass and every required independent check passes.
- `REJECTED` — evidence integrity/correlation fails or an independent check positively fails.
- `INDETERMINATE` — package is structurally valid enough to evaluate, but required independent evidence is unavailable, ambiguous, or not independent.

Verdict precedence is `REJECTED > INDETERMINATE > VERIFIED`.

`eligibleForVerification=true` from Business Ops is only admission to verification. It has no effect on the final verdict beyond allowing the package to be considered.

## Receipt

Sentinel emits `aftergraph.domain-verification.receipt/1.0` with:

- `receiptId`
- `verificationId`
- `subjectId`
- `verdict`
- `profile`
- `evidenceDigestSha256`
- ordered check results
- `verifierRef`
- `verifiedAt`
- `receiptDigestSha256`

`subjectId` is SHA-256 over canonical `{tenantId, missionId, effectId, idempotencyKey, evidenceDigestSha256}`. `receiptId` is the receipt digest with a `dvr_` prefix.

`receiptDigestSha256` is computed only over stable verification content: tenant/mission/effect/idempotency/evidence binding, verdict, reason, ordered checks, verifier and observer identity. `verifiedAt`, `receiptId` and `verificationId` are metadata/derived identifiers and MUST NOT influence the digest, so repeated verification of identical evidence and checks yields the same receipt id. Structurally bindable rejected/indeterminate attempts receive receipts; an input missing the fields needed to bind a subject does not fabricate one.
## Rendetalje projection

Rendetalje must not import Sentinel as an execution dependency. It adds a pure projection from `reconcileGovernedEffect(...)` inputs/results into `aftergraph.domain-evidence/1.0`.

The envelope body is the same reconciliation payload that produced `evidenceRef.digestSha256`, so Sentinel can independently recompute and compare the digest.

The projection must carry:

- exact tenant, mission, effect and idempotency correlation;
- the WORKS execution reference as `executorRef`;
- provider receipt reference, reconciliation status and read-back claim;
- no authority grants and no provider credentials.

## Sandbox proof

A durable cross-repo sensor uses:

- merged Rendetalje reconciliation code;
- Sentinel domain verifier;
- loopback-only independent read-back mock owned by the verifier harness;
- synthetic provider/WORKS data only.

Expected positive verdict: `VERIFIED` only when the independent observer returns a matching PASS. The same reconciled package without that observer must produce `INDETERMINATE`.
## Fail-closed behavior

The verifier rejects malformed schemas, digest mismatches, subject/body mismatches and positively failed independent checks. It returns `INDETERMINATE` for unavailable or non-independent observation. It never upgrades evidence based on model confidence, operator intent, or a prior `RECONCILED` label.

Check execution errors are represented as check results; raw secrets, request headers and connector internals must not appear in receipts.

## Acceptance criteria

1. Existing Sentinel code-review tests remain green.
2. Domain verification has isolated tests for VERIFIED, REJECTED and INDETERMINATE.
3. Tampered evidence and correlation spoofing are REJECTED.
4. Same-observer-as-executor can never produce VERIFIED.
5. Rendetalje projects an envelope whose digest Sentinel can recompute.
6. Cross-repo sandbox proof yields VERIFIED with independent PASS and INDETERMINATE without it.
7. No production endpoints, credentials, authority grants or provider writes are introduced.
8. The existing code-review `lib/verify.js` semantics remain unchanged.

## Durable verification service boundary

Sentinel may persist domain-verification receipts in a separate content-addressed store. This store is not the code-review evidence store and does not grant authority, dispatch work, or mutate business state.

The HTTP write boundary is `POST /api/domain/verify`. Its request body contains exactly one caller-owned field: `{ envelope }`. Verdicts, checks, verifier identity and observer identity are not accepted from the caller.

`domainVerifierRef` and `domainIndependentCheck` are server-owned dependencies. A missing independent checker is a supported fail-closed state and yields a durable `INDETERMINATE` receipt; it can never yield `VERIFIED`.
`sentinel serve` may configure `domainVerificationStorePath` and `domainVerifierRef` through the paired CLI/env settings. The stock CLI deliberately has no dynamic module-path or caller-provided checker option: loading a checker from an arbitrary path would create a new code-execution trust root. A deployment that needs `VERIFIED` must embed `createConsoleServer` with a Sentinel-owned checker implementation.

All `/api/*` routes, including domain verification, remain under the Console's existing bearer-token gate and fixed-window rate limiter. Receipt reads use `GET /api/domain/verification/:receiptId` and revalidate the content-addressed receipt before returning it.

The store is append-only at receipt identity: replaying the same stable receipt returns the first stored metadata instead of overwriting it. Corrupt or tampered receipts fail closed. An input too incomplete to bind tenant, mission, effect, idempotency and evidence digest does not fabricate a durable receipt.