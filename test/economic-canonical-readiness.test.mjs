import test from "node:test";
import assert from "node:assert/strict";
import { verifyCanonicalReadinessEvidence, falsifyCanonicalReadinessMutation } from "../lib/economic-canonical-readiness.js";

const valid = {
  schema:"aftergraph.economic-canonical-readiness-evidence/v1",
  externalEffects:0,
  signatureProduced:false,
  signingMaterialExposed:false,
  liveCustodyApiCalled:false,
  canBroadcast:false,
  canMoveAssets:false,
  final:false,
  humanApprovalBound:true,
  authorityLeaseBound:true,
  killSwitchCovered:true,
  revocationCovered:true,
  partialFailureCovered:true,
  compensationCovered:true,
  custodyRecoveryReferenceBound:true
};

test("accepts zero-effect canonical-readiness evidence without promotion authority", () => {
  const out=verifyCanonicalReadinessEvidence(valid);
  assert.equal(out.valid,true);
  assert.equal(out.final,false);
  assert.equal(out.promotionAuthority,false);
});

for (const [name, mutation] of [
  ["signature production",{signatureProduced:true}],
  ["signing material exposure",{signingMaterialExposed:true}],
  ["live custody API",{liveCustodyApiCalled:true}],
  ["broadcast capability",{canBroadcast:true}],
  ["asset movement",{canMoveAssets:true}],
  ["external effects",{externalEffects:1}],
  ["finality overclaim",{final:true}],
  ["missing human approval",{humanApprovalBound:false}],
  ["missing kill switch",{killSwitchCovered:false}],
  ["missing compensation",{compensationCovered:false}]
]) {
  test("rejects "+name, () => {
    const out=falsifyCanonicalReadinessMutation(valid,mutation);
    assert.equal(out.valid,false);
  });
}
