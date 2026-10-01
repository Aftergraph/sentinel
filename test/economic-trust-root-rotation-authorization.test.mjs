import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyAuthorizedEconomicTrustRootTransition, verifyEconomicTrustRootRotationAuthorization } from "../lib/economic-trust-root-rotation-authorization.js";

const H=c=>"sha256:"+c.repeat(64);
const state=(o={})=>{
  const s={sourceClass:"registry",sourceId:"registry_1",trustRootId:"root_1",publicKeyFingerprint:H("a"),generation:1,minAttestationGeneration:1,status:"ACTIVE",validFromUnix:1000,validUntilUnix:10000,revision:1,...o};
  const parts=[s.sourceClass,s.sourceId,s.trustRootId,s.publicKeyFingerprint,String(s.generation),String(s.minAttestationGeneration),s.status,String(s.validFromUnix),String(s.validUntilUnix),String(s.revision)];
  return {...s,stateDigest:"sha256:"+createHash("sha256").update(parts.join("\0")).digest("hex")};
};
function auth(prior,next,expiresAt=2_000_000_000_000){
  const payload={
    sourceClass:prior.sourceClass,sourceId:prior.sourceId,
    priorTrustRootId:prior.trustRootId,newTrustRootId:next.trustRootId,
    priorPublicKeyFingerprint:prior.publicKeyFingerprint,newPublicKeyFingerprint:next.publicKeyFingerprint,
    priorGeneration:prior.generation,newGeneration:next.generation,
    priorMinAttestationGeneration:prior.minAttestationGeneration,newMinAttestationGeneration:next.minAttestationGeneration,
    authorityLeaseId:"auth_1234567890123456",
    approvalProofIds:["apr_operator_1234567890","apr_reviewer_1234567890"],
    rotationNonce:"rot_registry_1234567890",reason:"scheduled_key_rotation",expiresAt
  };
  const parts=[
    "aftergraph/economic-trust-root-rotation/v1","GOVERNED_TRUST_ROOT_ROTATION",
    payload.sourceClass,payload.sourceId,payload.priorTrustRootId,payload.newTrustRootId,
    payload.priorPublicKeyFingerprint,payload.newPublicKeyFingerprint,
    String(payload.priorGeneration),String(payload.newGeneration),
    String(payload.priorMinAttestationGeneration),String(payload.newMinAttestationGeneration),
    payload.authorityLeaseId,[...payload.approvalProofIds].sort().join(","),
    payload.rotationNonce,payload.reason,String(payload.expiresAt)
  ];
  return {
    schema:"aftergraph.economic-trust-root-rotation-authorization/v1",
    decision:"AUTHORIZED_PREPARE_ONLY",authorized:true,trustRootMutationAuthorized:true,
    authorizationDigest:"sha256:"+createHash("sha256").update(parts.join("\0")).digest("hex"),
    payload,approvalsVerified:true,authorityVerified:true,
    executionAuthority:false,liveValueEnabled:false,final:false,promotionAuthority:false,externalEffects:0
  };
}

test("verifies authorized rotation end to end",()=>{
  const prior=state();
  const next=state({trustRootId:"root_2",publicKeyFingerprint:H("b"),generation:2,minAttestationGeneration:5,validFromUnix:2000,validUntilUnix:20000,revision:2});
  const transition={schema:"aftergraph.economic-source-trust-root-transition/v1",decision:"ROTATED",priorGeneration:1,current:next,externalEffects:0};
  const out=verifyAuthorizedEconomicTrustRootTransition(prior,transition,auth(prior,next),1_900_000_000_000);
  assert.equal(out.valid,true);
  assert.equal(out.state,"VERIFIED_AUTHORIZED_TRUST_ROOT_ROTATION");
  assert.equal(out.executionAuthority,false);
  assert.equal(out.liveValueEnabled,false);
});

for(const [name,mutate] of [
  ["tampered digest",(a)=>a.authorizationDigest=H("f")],
  ["unverified authority",(a)=>a.authorityVerified=false],
  ["unverified approvals",(a)=>a.approvalsVerified=false],
  ["single approval",(a)=>a.payload.approvalProofIds=["apr_operator_1234567890"]],
  ["mismatched target root",(a)=>a.payload.newTrustRootId="root_other"],
  ["expired",(a)=>a.payload.expiresAt=1_800_000_000_000],
  ["effect overclaim",(a)=>a.externalEffects=1]
]){
  test("rejects "+name,()=>{
    const prior=state();
    const next=state({trustRootId:"root_2",publicKeyFingerprint:H("b"),generation:2,minAttestationGeneration:5,validFromUnix:2000,validUntilUnix:20000,revision:2});
    const a=auth(prior,next); mutate(a);
    const out=verifyEconomicTrustRootRotationAuthorization(prior,next,a,1_900_000_000_000);
    assert.equal(out.valid,false);
  });
}

test("valid structural transition without authorization is invalid",()=>{
  const prior=state();
  const next=state({trustRootId:"root_2",publicKeyFingerprint:H("b"),generation:2,minAttestationGeneration:5,validFromUnix:2000,validUntilUnix:20000,revision:2});
  const transition={schema:"aftergraph.economic-source-trust-root-transition/v1",decision:"ROTATED",priorGeneration:1,current:next,externalEffects:0};
  const out=verifyAuthorizedEconomicTrustRootTransition(prior,transition,null,1_900_000_000_000);
  assert.equal(out.valid,false);
});
