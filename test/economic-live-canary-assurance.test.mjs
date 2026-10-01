import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { publicKeyFingerprint } from "../lib/economic-signer-canary.js";
import { verifyLiveCanaryAssurance } from "../lib/economic-live-canary-assurance.js";

const H=c=>"sha256:"+c.repeat(64);

function signerFixture(){
  const {publicKey,privateKey}=generateKeyPairSync("ed25519");
  const publicKeyPem=publicKey.export({type:"spki",format:"pem"}).toString();
  const fp=publicKeyFingerprint(publicKeyPem);
  const request={
    schema:"aftergraph.economic-signer-canary-request/v1",
    payload:{
      domain:"aftergraph/economic-signer-canary/v1",purpose:"NON_ECONOMIC_CANARY",
      nonce:"canary_assurance_123456",authorityLeaseId:"auth_1234567890123456",
      approvalProofId:"apr_1234567890123456",keyHandle:"keyref_assurance_canary_0001",
      publicKeyFingerprint:fp,expiresAt:1_900_000_000_000
    },
    challengeDigest:H("a"),algorithm:"Ed25519",signatureRequested:true,
    transactionPayloadPresent:false,canBroadcast:false,externalEffects:0
  };
  const signature=sign(null,Buffer.from(request.challengeDigest),privateKey);
  const receipt={
    schema:"aftergraph.external-signer-receipt/v1",providerId:"signer_assurance_01",
    challengeDigest:request.challengeDigest,keyHandle:request.payload.keyHandle,keyGeneration:1,
    keyStateAtSigning:"ACTIVE",publicKeyFingerprint:fp,publicKeyPem,algorithm:"Ed25519",
    signatureBase64:signature.toString("base64"),signingMaterialExposed:false,
    transactionPayloadSigned:false,canBroadcast:false,externalEffects:0
  };
  return {request,receipt};
}

function fixture(){
  const registryEvidence=H("6"),custodyEvidence=H("7"),representationEvidence=H("8");
  const legal={
    canonical:{assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),jurisdiction:"DK"},
    registry:{schema:"aftergraph.authoritative-asset-registry-record/v1",registryId:"registry_1",assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),recordHash:H("3"),evidenceHash:registryEvidence,status:"ACTIVE",externalEffects:0,final:false},
    custody:{schema:"aftergraph.custodial-right-record/v1",custodianId:"custodian_1",custodyRef:"cust_assurance_0001",assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),accountFingerprint:H("9"),recordHash:H("4"),evidenceHash:custodyEvidence,status:"ACTIVE",externalEffects:0,final:false},
    representation:{schema:"aftergraph.ledger-asset-representation-record/v1",network:"ledger_1",representationId:"token_1",assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),representationHash:H("5"),evidenceHash:representationEvidence,status:"ACTIVE",externalEffects:0,final:false},
    reconciliation:{schema:"aftergraph.economic-legal-reconciliation/v1",assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),state:"LEGAL_RIGHT_ALIGNED",final:false,externalEffects:0,reconciliationRequired:false,evidenceSources:["custody","registry","representation"],reasons:[]}
  };
  const correlation={
    economicTransactionId:"econ_assurance_1",intentHash:H("b"),legalBindingHash:H("c"),
    obligations:[
      {legId:"asset",kind:"asset",rail:"rail_asset",obligationHash:H("d"),legalBindingHash:H("c")},
      {legId:"cash",kind:"cash",rail:"rail_cash",obligationHash:H("e"),legalBindingHash:H("c")}
    ],
    receipts:[
      {schema:"aftergraph.rail-settlement-receipt/v1",economicTransactionId:"econ_assurance_1",legId:"asset",kind:"asset",rail:"rail_asset",obligationHash:H("d"),legalBindingHash:H("c"),sourceEvidenceHash:H("f"),outcome:"COMMITTED",externalEffects:0,final:false},
      {schema:"aftergraph.rail-settlement-receipt/v1",economicTransactionId:"econ_assurance_1",legId:"cash",kind:"cash",rail:"rail_cash",obligationHash:H("e"),legalBindingHash:H("c"),sourceEvidenceHash:H("0"),outcome:"COMMITTED",externalEffects:0,final:false}
    ],
    correlation:{schema:"aftergraph.economic-settlement-correlation/v1",economicTransactionId:"econ_assurance_1",intentHash:H("b"),legalBindingHash:H("c"),state:"CORRELATED",final:false,externalEffects:0,reconciliationRequired:false,matchedLegs:["asset","cash"],reasons:[]}
  };
  const coherence={
    policy:{nowUnix:2_000_000,maxAgeSeconds:300,maxSkewSeconds:30,maxFutureSkewSeconds:5},
    observations:[
      {sourceClass:"registry",sourceId:"registry_1",evidenceHash:registryEvidence,observedAtUnix:1_999_900,generation:11},
      {sourceClass:"custody",sourceId:"custodian_1",evidenceHash:custodyEvidence,observedAtUnix:1_999_910,generation:21},
      {sourceClass:"representation",sourceId:"ledger_1",evidenceHash:representationEvidence,observedAtUnix:1_999_920,generation:31}
    ],
    previousGenerations:{registry_1:10,custodian_1:20,ledger_1:30},
    coherence:{schema:"aftergraph.economic-evidence-coherence/v1",state:"TEMPORALLY_COHERENT",final:false,externalEffects:0,refreshRequired:false,observedSources:["custody:custodian_1","registry:registry_1","representation:ledger_1"],oldestObservedAtUnix:1_999_900,newestObservedAtUnix:1_999_920,reasons:[]}
  };
  const custodyObservation={schema:"aftergraph.external-custody-observation/v1",providerId:"custodian_assurance_01",custodyRef:"cust_assurance_0001",accountFingerprint:H("9"),recoveryPolicyRef:"rec_assurance_0001",stateDigest:H("a"),observedAt:"2026-10-01T00:00:00Z",readOnly:true,liveWriteApiCalled:false,canMoveAssets:false,canWithdraw:false,canRecoverAssets:false,externalEffects:0};
  const custodyRecovery={schema:"aftergraph.custody-recovery-canary-receipt/v1",challenge:{domain:"aftergraph/economic-custody-recovery-canary/v1",purpose:"NON_ECONOMIC_RECOVERY_DRY_RUN",providerId:"custodian_assurance_01",custodyRef:"cust_assurance_0001",accountFingerprint:H("9"),recoveryPolicyRef:"rec_assurance_0001",authorityLeaseId:"auth_1234567890123456",approvalProofIds:["apr_operator_1234567890","apr_reviewer_1234567890"],nonce:"recovery_assurance_123456",expiresAt:1_900_000_000_000},challengeDigest:H("b"),planDigest:H("c"),dryRun:true,twoPersonApprovalBound:true,authorityLeaseBound:true,liveWriteApiCalled:false,assetMovementRequested:false,assetMovementPerformed:false,canMoveAssets:false,canWithdraw:false,canRecoverAssets:false,final:false,externalEffects:0};
  return {
    now:1_800_000_000_000,
    expected:{economicTransactionId:"econ_assurance_1",legalBindingHash:H("c"),assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),custodyRef:"cust_assurance_0001"},
    settlementCorrelation:correlation,legalReconciliation:legal,evidenceCoherence:coherence,
    signer:signerFixture(),custody:{observation:custodyObservation,recovery:custodyRecovery}
  };
}

test("composite assurance reaches review readiness but never authority",()=>{
  const out=verifyLiveCanaryAssurance(fixture());
  assert.equal(out.state,"READY_FOR_LIVE_CANARY_REVIEW");
  assert.equal(out.readyForLiveCanaryReview,true);
  assert.equal(out.executionAuthority,false);
  assert.equal(out.liveValueEnabled,false);
  assert.equal(out.maxLiveValue,0);
  assert.equal(out.final,false);
  assert.equal(out.promotionAuthority,false);
  assert.equal(out.externalEffects,0);
});

for(const [name,mutate] of [
  ["transaction mismatch",x=>x.settlementCorrelation.receipts[1].economicTransactionId="econ_other"],
  ["legal mismatch",x=>x.legalReconciliation.custody.rightsHash=H("1")],
  ["stale evidence",x=>x.evidenceCoherence.observations[0].observedAtUnix=1_999_000],
  ["signer tamper",x=>x.signer.receipt.signatureBase64=Buffer.alloc(64,1).toString("base64")],
  ["custody duplicate approvals",x=>x.custody.recovery.challenge.approvalProofIds=["apr_same_123456789012","apr_same_123456789012"]],
  ["freshness evidence not bound to legal record",x=>x.evidenceCoherence.observations[0].evidenceHash=H("d")],
  ["custody fingerprint mismatch",x=>x.custody.observation.accountFingerprint=H("0")]
]){
  test("composite assurance rejects "+name,()=>{
    const x=fixture();mutate(x);
    const out=verifyLiveCanaryAssurance(x);
    assert.equal(out.readyForLiveCanaryReview,false);
    assert.equal(out.state,"NOT_READY");
    assert.equal(out.executionAuthority,false);
    assert.equal(out.maxLiveValue,0);
  });
}
