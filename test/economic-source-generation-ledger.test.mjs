import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyEconomicSourceGenerationTransition } from "../lib/economic-source-generation-ledger.js";

const H=c=>"sha256:"+c.repeat(64);
function state(generation=11){
  const s={
    sourceClass:"registry",
    sourceId:"registry_1",
    generation,
    cursorKind:"version",
    cursorValue:String(generation),
    observedAtUnix:1_999_900+(generation-11)*10,
    evidenceHash:generation===11?H("a"):H("d"),
    recordDigest:generation===11?H("b"):H("e"),
    captureHash:generation===11?H("c"):H("f"),
    revision:generation===11?1:2
  };
  const parts=[s.sourceClass,s.sourceId,String(s.generation),s.cursorKind,s.cursorValue,String(s.observedAtUnix),s.evidenceHash,s.recordDigest,s.captureHash,String(s.revision)];
  return {...s,stateDigest:"sha256:"+createHash("sha256").update(parts.join("\x00")).digest("hex")};
}
function proposedFrom(s){
  const {revision,stateDigest,...p}=s;
  return p;
}

test("verifies genesis ADVANCED transition",()=>{
  const proposed=proposedFrom(state(11));
  const current=state(11);
  const out=verifyEconomicSourceGenerationTransition({
    prior:null,proposed,
    transition:{schema:"aftergraph.economic-source-generation-transition/v1",decision:"ADVANCED",priorGeneration:0,current,externalEffects:0}
  });
  assert.equal(out.valid,true);
  assert.equal(out.decision,"ADVANCED");
  assert.equal(out.executionAuthority,false);
});

test("verifies monotonic ADVANCED transition",()=>{
  const prior=state(11);
  const current=state(12);
  const proposed=proposedFrom(current);
  const out=verifyEconomicSourceGenerationTransition({
    prior,proposed,
    transition:{schema:"aftergraph.economic-source-generation-transition/v1",decision:"ADVANCED",priorGeneration:11,current,externalEffects:0}
  });
  assert.equal(out.valid,true);
  assert.equal(out.decision,"ADVANCED");
});

test("verifies exact replay without revision mutation",()=>{
  const prior=state(11);
  const out=verifyEconomicSourceGenerationTransition({
    prior,proposed:proposedFrom(prior),
    transition:{schema:"aftergraph.economic-source-generation-transition/v1",decision:"IDEMPOTENT_REPLAY",priorGeneration:11,current:prior,externalEffects:0}
  });
  assert.equal(out.valid,true);
  assert.equal(out.decision,"IDEMPOTENT_REPLAY");
});

for(const [name,mutate,reason] of [
  ["generation regression",p=>p.generation=10,"generation_regression"],
  ["same-generation equivocation",p=>p.evidenceHash=H("9"),"generation_equivocation"],
  ["time rollback",p=>{p.generation=12;p.cursorValue="12";p.observedAtUnix=1_999_899;},"time_regression"],
  ["cursor-kind drift",p=>{p.generation=12;p.cursorKind="offset";p.cursorValue="12";p.observedAtUnix=1_999_910;},"cursor_kind_change"]
]){
  test("rejects "+name+" acceptance overclaim",()=>{
    const prior=state(11);
    const proposed=proposedFrom(prior);
    mutate(proposed);
    const out=verifyEconomicSourceGenerationTransition({
      prior,proposed,
      transition:{schema:"aftergraph.economic-source-generation-transition/v1",decision:"ADVANCED",priorGeneration:11,current:state(12),externalEffects:0}
    });
    assert.equal(out.valid,false);
    assert.ok(out.reasons.includes(reason));
    assert.ok(out.reasons.includes("transition_overclaims_acceptance"));
  });
}

test("rejects corrupted prior state digest",()=>{
  const prior=state(11); prior.stateDigest=H("0");
  const out=verifyEconomicSourceGenerationTransition({
    prior,proposed:proposedFrom(state(12)),
    transition:{schema:"aftergraph.economic-source-generation-transition/v1",decision:"ADVANCED",priorGeneration:11,current:state(12),externalEffects:0}
  });
  assert.equal(out.valid,false);
  assert.ok(out.reasons.includes("prior_state_digest"));
});

test("rejects transition external effects and forged current state",()=>{
  const prior=state(11);
  const current=state(12); current.captureHash=H("1");
  const out=verifyEconomicSourceGenerationTransition({
    prior,proposed:proposedFrom(state(12)),
    transition:{schema:"aftergraph.economic-source-generation-transition/v1",decision:"ADVANCED",priorGeneration:11,current,externalEffects:1}
  });
  assert.equal(out.valid,false);
  assert.ok(out.reasons.includes("transition_external_effects"));
  assert.ok(out.reasons.includes("transition_current_state"));
});
