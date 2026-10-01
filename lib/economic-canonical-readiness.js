export function verifyCanonicalReadinessEvidence(evidence) {
  const reasons = [];
  if (evidence?.schema !== "aftergraph.economic-canonical-readiness-evidence/v1") reasons.push("schema");
  if (evidence?.externalEffects !== 0) reasons.push("external_effects");
  if (evidence?.signatureProduced !== false) reasons.push("signature_produced");
  if (evidence?.signingMaterialExposed !== false) reasons.push("signing_material_exposed");
  if (evidence?.liveCustodyApiCalled !== false) reasons.push("live_custody_api_called");
  if (evidence?.canBroadcast !== false) reasons.push("broadcast_capability");
  if (evidence?.canMoveAssets !== false) reasons.push("asset_move_capability");
  if (evidence?.final !== false) reasons.push("finality_overclaim");

  const required = [
    "humanApprovalBound",
    "authorityLeaseBound",
    "killSwitchCovered",
    "revocationCovered",
    "partialFailureCovered",
    "compensationCovered",
    "custodyRecoveryReferenceBound"
  ];
  for (const key of required) {
    if (evidence?.[key] !== true) reasons.push(key);
  }

  return {
    valid: reasons.length === 0,
    state: reasons.length === 0 ? "CANONICAL_READINESS_EVIDENCE_ACCEPTED" : "INVALID",
    final: false,
    promotionAuthority: false,
    reasons
  };
}

export function falsifyCanonicalReadinessMutation(evidence, mutation) {
  return verifyCanonicalReadinessEvidence({ ...evidence, ...mutation });
}
