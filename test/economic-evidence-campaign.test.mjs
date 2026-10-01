import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyEconomicEvidenceCampaign } from "../lib/economic-evidence-campaign.js";

const H=c=>"sha256:"+c.repeat(64);
const stable=value=>{
  if(value===null||typeof value!=="object") return JSON.stringify(value);
  if(Array.isArray(value)) return "["+value.map(stable).join(",")+"]";
  return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+stable(value[k])).join(",")+"}";
};
const sha=value=>"sha256:"+createHash("sha256").update(value).digest("hex");

function fixture(){
  const expectation={assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2")};
  const records={
    custody:{schema:"aftergraph.custodial-right-record/v1",custodianId:"custodian_1",custodyRef:"cust_1",assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),accountFingerprint:H("9"),recordHash:H("4"),evidenceHash:H("7"),status:"ACTIVE",observedAt:"2026-10-01T18:00:05Z",externalEffects:0,final:false},
    registry:{schema:"aftergraph.authoritative-asset-registry-record/v1",registryId:"registry_1",assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),recordHash:H("3"),evidenceHash:H("6"),status:"ACTIVE",observedAt:"2026-10-01T18:00:00Z",externalEffects:0,final:false},
    representation:{schema:"aftergraph.ledger-asset-representation-record/v1",network:"ledger_1",representationId:"token_1",assetId:"asset_1",rightId:"right_1",legalInstrumentHash:H("1"),rightsHash:H("2"),representationHash:H("5"),evidenceHash:H("8"),status:"ACTIVE",observedAt:"2026-10-01T18:00:10Z",externalEffects:0,final:false},
  };
  const snapshots=[
    {schema:"aftergraph.economic-evidence-source-snapshot/v1",sourceClass:"custody",sourceId:"custodian_1",generation:21,observedAtUnix:1790877605,recordSchema:records.custody.schema,evidenceHash:records.custody.evidenceHash,recordHash:records.custody.recordHash,record:records.custody,externalEffects:0,final:false},
    {schema:"aftergraph.economic-evidence-source-snapshot/v1",sourceClass:"registry",sourceId:"registry_1",generation:11,observedAtUnix:1790877600,recordSchema:records.registry.schema,evidenceHash:records.registry.evidenceHash,recordHash:records.registry.recordHash,record:records.registry,externalEffects:0,final:false},
    {schema:"aftergraph.economic-evidence-source-snapshot/v1",sourceClass:"representation",sourceId:"ledger_1",generation:31,observedAtUnix:1790877610,recordSchema:records.representation.schema,evidenceHash:records.representation.evidenceHash,recordHash:records.representation.representationHash,record:records.representation,externalEffects:0,final:false},
  ];
  const sourceSeparationDigest=sha(stable(snapshots.map(s=>({sourceClass:s.sourceClass,sourceId:s.sourceId,generation:s.generation,evidenceHash:s.evidenceHash}))));
  const core={schema:"aftergraph.economic-evidence-campaign/v1",campaignId:"campaign_001",expectation,snapshots,sourceSeparationDigest,executionAuthority:false,liveValueEnabled:false,externalEffects:0,final:false};
  const pack={...core,packHash:sha(stable(core))};
  return {
    jurisdiction:"DK",
    policy:{nowUnix:1790877700,maxAgeSeconds:300,maxSkewSeconds:30,maxFutureSkewSeconds:5},
    previousGenerations:{registry_1:10,custodian_1:20,ledger_1:30},
    pack
  };
}

test("independently verifies EvidencePack integrity, legal binding and freshness",()=>{
  const out=verifyEconomicEvidenceCampaign(fixture());
  assert.equal(out.valid,true);
  assert.equal(out.state,"VERIFIED_EVIDENCE_CAMPAIGN");
  assert.equal(out.sourceSeparationVerified,true);
  assert.equal(out.legalRightAligned,true);
  assert.equal(out.temporallyCoherent,true);
  assert.equal(out.executionAuthority,false);
  assert.equal(out.liveValueEnabled,false);
  assert.equal(out.maxLiveValue,0);
  assert.equal(out.final,false);
  assert.equal(out.promotionAuthority,false);
  assert.equal(out.externalEffects,0);
});

for(const [name,mutate] of [
  ["pack hash tamper",x=>x.pack.packHash=H("0")],
  ["source separation digest tamper",x=>x.pack.sourceSeparationDigest=H("0")],
  ["evidence projection mismatch",x=>x.pack.snapshots[0].evidenceHash=H("0")],
  ["source identity mismatch",x=>x.pack.snapshots[1].sourceId="registry_other"],
  ["legal rights mismatch",x=>x.pack.snapshots[2].record.rightsHash=H("1")],
  ["stale snapshot",x=>x.pack.snapshots[1].observedAtUnix=1790877000],
  ["generation replay",x=>x.pack.snapshots[1].generation=10],
  ["duplicate evidence",x=>x.pack.snapshots[2].evidenceHash=x.pack.snapshots[1].evidenceHash],
  ["authority overclaim",x=>x.pack.executionAuthority=true],
]){
  test("rejects "+name,()=>{
    const x=fixture();mutate(x);
    const out=verifyEconomicEvidenceCampaign(x);
    assert.equal(out.valid,false);
    assert.equal(out.state,"EVIDENCE_CAMPAIGN_INVALID");
    assert.equal(out.executionAuthority,false);
    assert.equal(out.maxLiveValue,0);
  });
}
