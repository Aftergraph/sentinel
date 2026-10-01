import test from "node:test";
import assert from "node:assert/strict";
import { verifyCustodyObservation, verifyCustodyRecoveryCanary, verifyCustodyReferenceRevocation } from "../lib/economic-custody-provider.js";

const observation={
  schema:"aftergraph.external-custody-observation/v1",
  providerId:"custodian_test_vault_01",
  custodyRef:"cust_external_vault_0001",
  accountFingerprint:"sha256:"+"a".repeat(64),
  recoveryPolicyRef:"rec_two_person_recovery_0001",
  stateDigest:"sha256:"+"b".repeat(64),
  observedAt:"2026-10-01T00:00:00Z",
  readOnly:true,
  liveWriteApiCalled:false,
  canMoveAssets:false,
  canWithdraw:false,
  canRecoverAssets:false,
  externalEffects:0
};

const recovery={
  schema:"aftergraph.custody-recovery-canary-receipt/v1",
  challenge:{
    domain:"aftergraph/economic-custody-recovery-canary/v1",
    purpose:"NON_ECONOMIC_RECOVERY_DRY_RUN",
    providerId:"custodian_test_vault_01",
    custodyRef:"cust_external_vault_0001",
    accountFingerprint:"sha256:"+"a".repeat(64),
    recoveryPolicyRef:"rec_two_person_recovery_0001",
    authorityLeaseId:"auth_1234567890123456",
    approvalProofIds:["apr_operator_1234567890","apr_reviewer_1234567890"],
    nonce:"recovery_canary_01_123456",
    expiresAt:1_900_000_000_000
  },
  challengeDigest:"sha256:"+"c".repeat(64),
  planDigest:"sha256:"+"d".repeat(64),
  dryRun:true,
  twoPersonApprovalBound:true,
  authorityLeaseBound:true,
  liveWriteApiCalled:false,
  assetMovementRequested:false,
  assetMovementPerformed:false,
  canMoveAssets:false,
  canWithdraw:false,
  canRecoverAssets:false,
  final:false,
  externalEffects:0
};

test("verifies read-only custody observation",()=>{
  const out=verifyCustodyObservation(observation);
  assert.equal(out.valid,true); assert.equal(out.final,false); assert.equal(out.promotionAuthority,false);
});

for(const [name,mut] of [
  ["write api",{liveWriteApiCalled:true}],
  ["move capability",{canMoveAssets:true}],
  ["withdraw capability",{canWithdraw:true}],
  ["effects",{externalEffects:1}]
]) test("rejects observation "+name,()=>assert.equal(verifyCustodyObservation({...observation,...mut}).valid,false));

test("verifies two-person recovery dry-run without asset movement",()=>{
  const out=verifyCustodyRecoveryCanary(recovery,1_800_000_000_000);
  assert.equal(out.valid,true); assert.equal(out.canMoveAssets,false); assert.equal(out.final,false);
});

for(const [name,mut] of [
  ["movement requested",{assetMovementRequested:true}],
  ["movement performed",{assetMovementPerformed:true}],
  ["write api",{liveWriteApiCalled:true}],
  ["finality",{final:true}],
  ["effects",{externalEffects:1}]
]) test("rejects recovery "+name,()=>assert.equal(verifyCustodyRecoveryCanary({...recovery,...mut},1_800_000_000_000).valid,false));

test("rejects duplicate human approvals",()=>{
  const bad={...recovery,challenge:{...recovery.challenge,approvalProofIds:["apr_same_123456789012","apr_same_123456789012"]}};
  assert.equal(verifyCustodyRecoveryCanary(bad,1_800_000_000_000).valid,false);
});

test("verifies custody reference revocation",()=>{
  const out=verifyCustodyReferenceRevocation({
    schema:"aftergraph.custody-reference-revocation/v1",
    providerId:"custodian_test_vault_01",
    custodyRef:"cust_external_vault_0001",
    accountFingerprint:"sha256:"+"a".repeat(64),
    recoveryPolicyRef:"rec_two_person_recovery_0001",
    reason:"operator_kill_switch",
    state:"REVOKED",
    canMoveAssets:false,
    externalEffects:0
  });
  assert.equal(out.valid,true);
});
