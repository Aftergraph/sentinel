import test from "node:test";
import assert from "node:assert/strict";
import { verifyLegalAssetReconciliation } from "../lib/economic-legal-reconciliation.js";

const H=c=>"sha256:"+c.repeat(64);
function fixture(){
  const canonical={assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),jurisdiction:"DK"};
  const registry={schema:"aftergraph.authoritative-asset-registry-record/v1",registryId:"registry_1",assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),recordHash:H("3"),evidenceHash:H("6"),status:"ACTIVE",externalEffects:0,final:false};
  const custody={schema:"aftergraph.custodial-right-record/v1",custodianId:"custodian_1",custodyRef:"cust_1",assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),accountFingerprint:H("9"),recordHash:H("4"),evidenceHash:H("7"),status:"ACTIVE",externalEffects:0,final:false};
  const representation={schema:"aftergraph.ledger-asset-representation-record/v1",network:"test-ledger",representationId:"token_1",assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),representationHash:H("5"),evidenceHash:H("8"),status:"ACTIVE",externalEffects:0,final:false};
  const reconciliation={schema:"aftergraph.economic-legal-reconciliation/v1",assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),state:"LEGAL_RIGHT_ALIGNED",final:false,externalEffects:0,reconciliationRequired:false,evidenceSources:["custody","registry","representation"],reasons:[]};
  return {canonical,registry,custody,representation,reconciliation};
}

test("verifies legal right alignment independently",()=>{
  const out=verifyLegalAssetReconciliation(fixture());
  assert.equal(out.valid,true);
  assert.equal(out.legalRightAligned,true);
  assert.equal(out.state,"VERIFIED_LEGAL_RIGHT_ALIGNMENT");
  assert.equal(out.final,false);
  assert.equal(out.promotionAuthority,false);
});

for(const [name,mutate] of [
  ["registry asset mismatch",x=>x.registry.assetId="asset_other"],
  ["custody rights mismatch",x=>x.custody.rightsHash=H("1")],
  ["representation legal instrument mismatch",x=>x.representation.legalInstrumentHash=H("2")],
  ["registry suspended",x=>x.registry.status="SUSPENDED"],
  ["custody revoked",x=>x.custody.status="REVOKED"],
  ["representation unknown",x=>x.representation.status="UNKNOWN"],
  ["reused source evidence",x=>x.custody.evidenceHash=x.registry.evidenceHash],
  ["registry external effect",x=>x.registry.externalEffects=1],
  ["representation finality overclaim",x=>x.representation.final=true]
]){
  test("rejects "+name,()=>{
    const x=fixture(); mutate(x);
    x.reconciliation.state="LEGAL_RECONCILIATION_REQUIRED";
    x.reconciliation.reconciliationRequired=true;
    const out=verifyLegalAssetReconciliation(x);
    assert.equal(out.valid,false);
    assert.equal(out.state,"LEGAL_RECONCILIATION_REQUIRED");
    assert.equal(out.final,false);
  });
}

test("rejects WORKS alignment overclaim over mismatched underlying records",()=>{
  const x=fixture();
  x.custody.assetId="asset_other";
  const out=verifyLegalAssetReconciliation(x);
  assert.equal(out.valid,false);
  assert.ok(out.reasons.includes("claim:overclaims_alignment"));
});

test("rejects reconciliation claiming finality",()=>{
  const x=fixture(); x.reconciliation.final=true;
  assert.equal(verifyLegalAssetReconciliation(x).valid,false);
});
