import test from "node:test";
import assert from "node:assert/strict";
import { verifyEvidenceCoherence } from "../lib/economic-evidence-coherence.js";
const H=c=>"sha256:"+c.repeat(64);
function fixture(){
  return {
    policy:{nowUnix:2_000_000,maxAgeSeconds:300,maxSkewSeconds:30,maxFutureSkewSeconds:5},
    observations:[
      {sourceClass:"registry",sourceId:"registry_1",evidenceHash:H("a"),observedAtUnix:1_999_900,generation:11},
      {sourceClass:"custody",sourceId:"custodian_1",evidenceHash:H("b"),observedAtUnix:1_999_910,generation:21},
      {sourceClass:"representation",sourceId:"ledger_1",evidenceHash:H("c"),observedAtUnix:1_999_920,generation:31}
    ],
    previousGenerations:{registry_1:10,custodian_1:20,ledger_1:30},
    coherence:{schema:"aftergraph.economic-evidence-coherence/v1",state:"TEMPORALLY_COHERENT",final:false,externalEffects:0,refreshRequired:false,observedSources:["custody:custodian_1","registry:registry_1","representation:ledger_1"],oldestObservedAtUnix:1_999_900,newestObservedAtUnix:1_999_920,reasons:[]}
  };
}
test("independently verifies temporal coherence",()=>{
  const out=verifyEvidenceCoherence(fixture());
  assert.equal(out.valid,true);assert.equal(out.temporallyCoherent,true);assert.equal(out.final,false);assert.equal(out.promotionAuthority,false);
});
for(const [name,mutate] of [
  ["stale registry",x=>x.observations[0].observedAtUnix=1_999_000],
  ["source skew",x=>x.observations[2].observedAtUnix=1_999_950],
  ["replayed generation",x=>x.observations[0].generation=10],
  ["future custody",x=>x.observations[1].observedAtUnix=2_000_010],
  ["missing representation",x=>x.observations=x.observations.slice(0,2)],
  ["duplicate class",x=>x.observations[2].sourceClass="custody"],
  ["evidence reuse",x=>x.observations[2].evidenceHash=x.observations[0].evidenceHash]
]){
  test("rejects "+name,()=>{
    const x=fixture();mutate(x);x.coherence.state="EVIDENCE_REFRESH_REQUIRED";x.coherence.refreshRequired=true;
    const out=verifyEvidenceCoherence(x);
    assert.equal(out.valid,false);assert.equal(out.state,"EVIDENCE_REFRESH_REQUIRED");assert.equal(out.final,false);
  });
}
test("rejects WORKS coherence overclaim",()=>{
  const x=fixture();x.observations[0].generation=10;
  const out=verifyEvidenceCoherence(x);
  assert.equal(out.valid,false);assert.ok(out.reasons.includes("claim:overclaims_coherence"));
});
test("rejects finality overclaim",()=>{
  const x=fixture();x.coherence.final=true;
  assert.equal(verifyEvidenceCoherence(x).valid,false);
});
