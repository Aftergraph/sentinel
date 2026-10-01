import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { publicKeyFingerprint } from "../lib/economic-signer-canary.js";
import { verifyLiveCanaryAssurance } from "../lib/economic-live-canary-assurance.js";
import { verifyEconomicEvidencePack } from "../lib/economic-evidence-pack.js";

const H=c=>"sha256:"+c.repeat(64);
const canonical=v=>{
  if(v===null||typeof v==="string"||typeof v==="boolean"||typeof v==="number") return v;
  if(Array.isArray(v)) return v.map(canonical);
  const o={}; for(const k of Object.keys(v).sort()) o[k]=canonical(v[k]); return o;
};
const hash=v=>"sha256:"+createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
const entry=(sequence,kind,subject,artifactHash,previousEntryHash)=>{
  const body={sequence,kind,subject,artifactHash,previousEntryHash};
  return {...body,entryHash:hash(body)};
};

function assuranceFixture(){
  const {publicKey,privateKey}=generateKeyPairSync("ed25519");
  const publicKeyPem=publicKey.export({type:"spki",format:"pem"}).toString();
  const fp=publicKeyFingerprint(publicKeyPem);
  const signerRequest={schema:"aftergraph.economic-signer-canary-request/v1",payload:{domain:"aftergraph/economic-signer-canary/v1",purpose:"NON_ECONOMIC_CANARY",nonce:"canary_pack_1234567890",authorityLeaseId:"auth_1234567890123456",approvalProofId:"apr_1234567890123456",keyHandle:"keyref_pack_canary_0001",publicKeyFingerprint:fp,expiresAt:1_900_000_000_000},challengeDigest:H("a"),algorithm:"Ed25519",signatureRequested:true,transactionPayloadPresent:false,canBroadcast:false,externalEffects:0};
  const signature=sign(null,Buffer.from(signerRequest.challengeDigest),privateKey);
  const signerReceipt={schema:"aftergraph.external-signer-receipt/v1",providerId:"signer_pack_0001",challengeDigest:signerRequest.challengeDigest,keyHandle:signerRequest.payload.keyHandle,keyGeneration:1,keyStateAtSigning:"ACTIVE",publicKeyFingerprint:fp,publicKeyPem,algorithm:"Ed25519",signatureBase64:signature.toString("base64"),signingMaterialExposed:false,transactionPayloadSigned:false,canBroadcast:false,externalEffects:0};

  const registryEvidence=H("6"),custodyEvidence=H("7"),representationEvidence=H("8");
  const legal={canonical:{assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),jurisdiction:"DK"},registry:{schema:"aftergraph.authoritative-asset-registry-record/v1",registryId:"registry_1",assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),recordHash:H("3"),evidenceHash:registryEvidence,status:"ACTIVE",externalEffects:0,final:false},custody:{schema:"aftergraph.custodial-right-record/v1",custodianId:"custodian_1",custodyRef:"cust_pack_00000001",assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),accountFingerprint:H("9"),recordHash:H("4"),evidenceHash:custodyEvidence,status:"ACTIVE",externalEffects:0,final:false},representation:{schema:"aftergraph.ledger-asset-representation-record/v1",network:"ledger_1",representationId:"token_1",assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),representationHash:H("5"),evidenceHash:representationEvidence,status:"ACTIVE",externalEffects:0,final:false},reconciliation:{schema:"aftergraph.economic-legal-reconciliation/v1",assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),state:"LEGAL_RIGHT_ALIGNED",final:false,externalEffects:0,reconciliationRequired:false,evidenceSources:["custody","registry","representation"],reasons:[]}};
  const settlement={economicTransactionId:"econ_pack_1",intentHash:H("b"),legalBindingHash:H("c"),obligations:[{legId:"asset",kind:"asset",rail:"rail_asset",obligationHash:H("d"),legalBindingHash:H("c")},{legId:"cash",kind:"cash",rail:"rail_cash",obligationHash:H("e"),legalBindingHash:H("c")}],receipts:[{schema:"aftergraph.rail-settlement-receipt/v1",economicTransactionId:"econ_pack_1",legId:"asset",kind:"asset",rail:"rail_asset",obligationHash:H("d"),legalBindingHash:H("c"),sourceEvidenceHash:H("f"),outcome:"COMMITTED",externalEffects:0,final:false},{schema:"aftergraph.rail-settlement-receipt/v1",economicTransactionId:"econ_pack_1",legId:"cash",kind:"cash",rail:"rail_cash",obligationHash:H("e"),legalBindingHash:H("c"),sourceEvidenceHash:H("0"),outcome:"COMMITTED",externalEffects:0,final:false}],correlation:{schema:"aftergraph.economic-settlement-correlation/v1",economicTransactionId:"econ_pack_1",intentHash:H("b"),legalBindingHash:H("c"),state:"CORRELATED",final:false,externalEffects:0,reconciliationRequired:false,matchedLegs:["asset","cash"],reasons:[]}};
  const coherence={policy:{nowUnix:2_000_000,maxAgeSeconds:300,maxSkewSeconds:30,maxFutureSkewSeconds:5},observations:[{sourceClass:"registry",sourceId:"registry_1",evidenceHash:registryEvidence,observedAtUnix:1_999_900,generation:11},{sourceClass:"custody",sourceId:"custodian_1",evidenceHash:custodyEvidence,observedAtUnix:1_999_910,generation:21},{sourceClass:"representation",sourceId:"ledger_1",evidenceHash:representationEvidence,observedAtUnix:1_999_920,generation:31}],previousGenerations:{registry_1:10,custodian_1:20,ledger_1:30},coherence:{schema:"aftergraph.economic-evidence-coherence/v1",state:"TEMPORALLY_COHERENT",final:false,externalEffects:0,refreshRequired:false,observedSources:["custody:custodian_1","registry:registry_1","representation:ledger_1"],oldestObservedAtUnix:1_999_900,newestObservedAtUnix:1_999_920,reasons:[]}};
  const custodyObservation={schema:"aftergraph.external-custody-observation/v1",providerId:"custodian_pack_0001",custodyRef:"cust_pack_00000001",accountFingerprint:H("9"),recoveryPolicyRef:"rec_pack_00000001",stateDigest:H("a"),observedAt:"2026-10-01T00:00:00Z",readOnly:true,liveWriteApiCalled:false,canMoveAssets:false,canWithdraw:false,canRecoverAssets:false,externalEffects:0};
  const custodyRecovery={schema:"aftergraph.custody-recovery-canary-receipt/v1",challenge:{domain:"aftergraph/economic-custody-recovery-canary/v1",purpose:"NON_ECONOMIC_RECOVERY_DRY_RUN",providerId:"custodian_pack_0001",custodyRef:"cust_pack_00000001",accountFingerprint:H("9"),recoveryPolicyRef:"rec_pack_00000001",authorityLeaseId:"auth_1234567890123456",approvalProofIds:["apr_operator_1234567890","apr_reviewer_1234567890"],nonce:"recovery_pack_1234567890",expiresAt:1_900_000_000_000},challengeDigest:H("b"),planDigest:H("c"),dryRun:true,twoPersonApprovalBound:true,authorityLeaseBound:true,liveWriteApiCalled:false,assetMovementRequested:false,assetMovementPerformed:false,canMoveAssets:false,canWithdraw:false,canRecoverAssets:false,final:false,externalEffects:0};
  const assurance={now:1_800_000_000_000,expected:{economicTransactionId:"econ_pack_1",legalBindingHash:H("c"),assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),custodyRef:"cust_pack_00000001"},settlementCorrelation:settlement,legalReconciliation:legal,evidenceCoherence:coherence,signer:{request:signerRequest,receipt:signerReceipt},custody:{observation:custodyObservation,recovery:custodyRecovery}};
  return {settlement,legal,coherence,assurance};
}

function fixture(){
  const a=assuranceFixture();
  const components={settlementCorrelation:a.settlement,legalReconciliation:a.legal,evidenceCoherence:a.coherence,liveCanaryAssurance:a.assurance};
  const captures=[
    {sourceClass:"custody",sourceId:"custodian_1",evidenceHash:H("7"),generation:21,observedAtUnix:1_999_910},
    {sourceClass:"registry",sourceId:"registry_1",evidenceHash:H("6"),generation:11,observedAtUnix:1_999_900},
    {sourceClass:"representation",sourceId:"ledger_1",evidenceHash:H("8"),generation:31,observedAtUnix:1_999_920}
  ];
  const componentDigests={settlementCorrelation:hash(components.settlementCorrelation),legalReconciliation:hash(components.legalReconciliation),evidenceCoherence:hash(components.evidenceCoherence),liveCanaryAssurance:hash(components.liveCanaryAssurance)};
  const chainInputs=[
    ...captures.map(x=>({kind:"source:"+x.sourceClass,subject:x.sourceId,hash:x.evidenceHash})),
    {kind:"component:settlement-correlation",subject:"econ_pack_1",hash:componentDigests.settlementCorrelation},
    {kind:"component:legal-reconciliation",subject:"asset_1:right_1",hash:componentDigests.legalReconciliation},
    {kind:"component:evidence-coherence",subject:"campaign_1",hash:componentDigests.evidenceCoherence},
    {kind:"component:live-canary-assurance",subject:"campaign_1",hash:componentDigests.liveCanaryAssurance}
  ];
  const evidenceChain=[]; let prev=null;
  chainInputs.forEach((x,i)=>{const e=entry(i+1,x.kind,x.subject,x.hash,prev);evidenceChain.push(e);prev=e.entryHash;});
  const body={schema:"aftergraph.economic-evidence-pack/v1",campaignId:"campaign_1",economicTransactionId:"econ_pack_1",assetId:"asset_1",rightId:"right_1",legalBindingHash:H("c"),generatedAtUnix:2_000_000,sourceCaptures:captures,componentDigests,evidenceChain,immutable:true,containsCredentials:false,liveValueEnabled:false,maxLiveValue:0,final:false,externalEffects:0};
  return {pack:{...body,manifestHash:hash(body)},components};
}

test("independently verifies immutable evidence pack",()=>{
  const out=verifyEconomicEvidencePack(fixture());
  assert.equal(out.valid,true);
  assert.equal(out.state,"VERIFIED_IMMUTABLE_EVIDENCE_PACK");
  assert.equal(out.readyForLiveCanaryReview,true);
  assert.equal(out.executionAuthority,false);
  assert.equal(out.liveValueEnabled,false);
  assert.equal(out.maxLiveValue,0);
});

for(const [name,mutate] of [
  ["component digest",x=>x.pack.componentDigests.legalReconciliation=H("f")],
  ["chain link",x=>x.pack.evidenceChain[3].previousEntryHash=H("e")],
  ["manifest hash",x=>x.pack.manifestHash=H("d")],
  ["source evidence binding",x=>x.pack.sourceCaptures[0].evidenceHash=H("a")],
  ["source generation binding",x=>x.pack.sourceCaptures[0].generation=999],
  ["live value overclaim",x=>x.pack.liveValueEnabled=true],
  ["max value overclaim",x=>x.pack.maxLiveValue=1],
  ["finality overclaim",x=>x.pack.final=true]
]){
  test("rejects tampered "+name,()=>{
    const x=fixture(); mutate(x);
    const out=verifyEconomicEvidencePack(x);
    assert.equal(out.valid,false);
    assert.equal(out.executionAuthority,false);
    assert.equal(out.maxLiveValue,0);
  });
}

test("rejects invalid component even if pack hashes are not changed",()=>{
  const x=fixture();
  x.components.evidenceCoherence.observations[0].generation=10;
  const out=verifyEconomicEvidencePack(x);
  assert.equal(out.valid,false);
  assert.ok(out.reasons.includes("component:coherence_invalid"));
});
