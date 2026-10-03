import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyEconomicTrustRootHistory } from "../lib/economic-source-trust-root-history.js";

const H=c=>"sha256:"+c.repeat(64);
const genesis="sha256:"+"0".repeat(64);
const make=(sequence,generation,decision,previousEventHash,authorizationDigest="")=>{
  const ev={sourceClass:"registry",sourceId:"registry_1",sequence,generation,decision,stateDigest:H(String(sequence)),authorizationDigest,previousEventHash};
  const parts=[ev.sourceClass,ev.sourceId,String(ev.sequence),String(ev.generation),ev.decision,ev.stateDigest,ev.authorizationDigest,ev.previousEventHash];
  return {...ev,eventHash:"sha256:"+createHash("sha256").update(parts.join("\0")).digest("hex")};
};
const fixture=()=>{
  const e1=make(1,4,"ADVANCED",genesis);
  const e2=make(2,5,"ADVANCED_POLICY",e1.eventHash);
  const e3=make(3,6,"ROTATED",e2.eventHash,H("a"));
  return [e1,e2,e3];
};

test("verifies complete append-only trust-root lineage",()=>{
  const out=verifyEconomicTrustRootHistory(fixture());
  assert.equal(out.valid,true);
  assert.equal(out.state,"VERIFIED_IMMUTABLE_TRUST_ROOT_LINEAGE");
  assert.equal(out.eventCount,3);
  assert.equal(out.executionAuthority,false);
  assert.equal(out.final,false);
});

for(const [name,mutate] of [
  ["deleted middle event",x=>x.splice(1,1)],
  ["inserted sequence gap",x=>x[1].sequence=3],
  ["tampered decision",x=>x[1].decision="ROTATED"],
  ["tampered state digest",x=>x[1].stateDigest=H("f")],
  ["broken previous hash",x=>x[2].previousEventHash=H("f")],
  ["tampered event hash",x=>x[2].eventHash=H("f")],
  ["missing rotation authorization",x=>x[2].authorizationDigest=""],
  ["generation jump",x=>x[2].generation=9],
  ["source identity change",x=>x[2].sourceId="registry_other"]
]){
  test("rejects "+name,()=>{
    const x=fixture();mutate(x);
    const out=verifyEconomicTrustRootHistory(x);
    assert.equal(out.valid,false);
    assert.equal(out.state,"INVALID");
  });
}

test("rejects authorization digest on non-rotation event",()=>{
  const x=fixture();
  x[1].authorizationDigest=H("e");
  assert.equal(verifyEconomicTrustRootHistory(x).valid,false);
});
