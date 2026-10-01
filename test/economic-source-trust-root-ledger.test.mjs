import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyEconomicTrustRootTransition } from "../lib/economic-source-trust-root-ledger.js";

const H=c=>"sha256:"+c.repeat(64);
const withDigest=s=>{
  const parts=[s.sourceClass,s.sourceId,s.trustRootId,s.publicKeyFingerprint,String(s.generation),String(s.minAttestationGeneration),s.status,String(s.validFromUnix),String(s.validUntilUnix),String(s.revision)];
  return {...s,stateDigest:"sha256:"+createHash("sha256").update(parts.join("\0")).digest("hex")};
};
const state=(o={})=>withDigest({sourceClass:"registry",sourceId:"registry_1",trustRootId:"root_1",publicKeyFingerprint:H("a"),generation:1,minAttestationGeneration:1,status:"ACTIVE",validFromUnix:1000,validUntilUnix:10000,revision:1,...o});

test("verifies genesis and exact replay",()=>{
  const first=state();
  let out=verifyEconomicTrustRootTransition(null,{schema:"aftergraph.economic-source-trust-root-transition/v1",decision:"ADVANCED",priorGeneration:0,current:first,externalEffects:0});
  assert.equal(out.valid,true);

  out=verifyEconomicTrustRootTransition(first,{schema:"aftergraph.economic-source-trust-root-transition/v1",decision:"IDEMPOTENT_REPLAY",priorGeneration:1,current:first,externalEffects:0});
  assert.equal(out.valid,true);
});

test("verifies sequential key rotation",()=>{
  const prior=state();
  const current=state({trustRootId:"root_2",publicKeyFingerprint:H("b"),generation:2,minAttestationGeneration:5,validFromUnix:2000,validUntilUnix:20000,revision:2});
  const out=verifyEconomicTrustRootTransition(prior,{schema:"aftergraph.economic-source-trust-root-transition/v1",decision:"ROTATED",priorGeneration:1,current,externalEffects:0});
  assert.equal(out.valid,true);
  assert.equal(out.executionAuthority,false);
});

for(const [name,mutate] of [
  ["generation gap",(p,c)=>c.generation=3],
  ["floor regression",(p,c)=>c.minAttestationGeneration=0],
  ["validity regression",(p,c)=>c.validFromUnix=500],
  ["wrong decision",(p,c,t)=>t.decision="ADVANCED_POLICY"],
  ["external effects",(p,c,t)=>t.externalEffects=1]
]){
  test("rejects "+name,()=>{
    let prior=state();
    let current=state({trustRootId:"root_2",publicKeyFingerprint:H("b"),generation:2,minAttestationGeneration:2,validFromUnix:2000,validUntilUnix:20000,revision:2});
    let transition={schema:"aftergraph.economic-source-trust-root-transition/v1",decision:"ROTATED",priorGeneration:1,current,externalEffects:0};
    mutate(prior,current,transition);
    current=withDigest(current); transition.current=current;
    assert.equal(verifyEconomicTrustRootTransition(prior,transition).valid,false);
  });
}

test("rejects same-generation equivocation",()=>{
  const prior=state();
  const current=state({status:"REVOKED"});
  const out=verifyEconomicTrustRootTransition(prior,{schema:"aftergraph.economic-source-trust-root-transition/v1",decision:"IDEMPOTENT_REPLAY",priorGeneration:1,current,externalEffects:0});
  assert.equal(out.valid,false);
});

test("rejects revoked-key revival but accepts rotation to a new key",()=>{
  const prior=state({status:"REVOKED"});
  const revived=state({status:"ACTIVE",generation:2,validFromUnix:2000,validUntilUnix:20000,revision:2});
  let out=verifyEconomicTrustRootTransition(prior,{schema:"aftergraph.economic-source-trust-root-transition/v1",decision:"ADVANCED_POLICY",priorGeneration:1,current:revived,externalEffects:0});
  assert.equal(out.valid,false);

  const rotated=state({status:"ACTIVE",trustRootId:"root_2",publicKeyFingerprint:H("b"),generation:2,validFromUnix:2000,validUntilUnix:20000,revision:2});
  out=verifyEconomicTrustRootTransition(prior,{schema:"aftergraph.economic-source-trust-root-transition/v1",decision:"ROTATED",priorGeneration:1,current:rotated,externalEffects:0});
  assert.equal(out.valid,true);
});
