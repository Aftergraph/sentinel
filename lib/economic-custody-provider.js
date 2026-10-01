export function verifyCustodyObservation(receipt) {
  const reasons=[];
  if(receipt?.schema!=="aftergraph.external-custody-observation/v1") reasons.push("schema");
  if(!/^custodian_[A-Za-z0-9_-]{8,}$/.test(String(receipt?.providerId||""))) reasons.push("provider_id");
  if(!/^cust_[A-Za-z0-9_-]{12,}$/.test(String(receipt?.custodyRef||""))) reasons.push("custody_ref");
  if(!/^sha256:[a-f0-9]{64}$/.test(String(receipt?.accountFingerprint||""))) reasons.push("account_fingerprint");
  if(!/^sha256:[a-f0-9]{64}$/.test(String(receipt?.stateDigest||""))) reasons.push("state_digest");
  if(receipt?.readOnly!==true) reasons.push("read_only");
  if(receipt?.liveWriteApiCalled!==false) reasons.push("live_write_api");
  if(receipt?.canMoveAssets!==false) reasons.push("move_capability");
  if(receipt?.canWithdraw!==false) reasons.push("withdraw_capability");
  if(receipt?.canRecoverAssets!==false) reasons.push("recovery_capability");
  if(receipt?.externalEffects!==0) reasons.push("external_effects");
  return {
    schema:"aftergraph.custody-observation-verification/v1",
    valid:reasons.length===0,
    state:reasons.length===0?"VERIFIED_READ_ONLY_CUSTODY_OBSERVATION":"INVALID",
    final:false,
    promotionAuthority:false,
    externalEffects:0,
    reasons
  };
}

export function verifyCustodyRecoveryCanary(receipt, now=Date.now()) {
  const reasons=[];
  if(receipt?.schema!=="aftergraph.custody-recovery-canary-receipt/v1") reasons.push("schema");
  if(receipt?.challenge?.purpose!=="NON_ECONOMIC_RECOVERY_DRY_RUN") reasons.push("purpose");
  if(receipt?.challenge?.expiresAt<=now) reasons.push("expired");
  if(!Array.isArray(receipt?.challenge?.approvalProofIds)||receipt.challenge.approvalProofIds.length<2) reasons.push("two_person_approval");
  if(receipt?.twoPersonApprovalBound!==true) reasons.push("approval_binding");
  if(receipt?.authorityLeaseBound!==true) reasons.push("authority_binding");
  if(receipt?.dryRun!==true) reasons.push("dry_run");
  if(receipt?.liveWriteApiCalled!==false) reasons.push("live_write_api");
  if(receipt?.assetMovementRequested!==false) reasons.push("asset_movement_requested");
  if(receipt?.assetMovementPerformed!==false) reasons.push("asset_movement_performed");
  if(receipt?.canMoveAssets!==false) reasons.push("move_capability");
  if(receipt?.canWithdraw!==false) reasons.push("withdraw_capability");
  if(receipt?.canRecoverAssets!==false) reasons.push("recovery_capability");
  if(receipt?.final!==false) reasons.push("finality");
  if(receipt?.externalEffects!==0) reasons.push("external_effects");
  if(!/^sha256:[a-f0-9]{64}$/.test(String(receipt?.challengeDigest||""))) reasons.push("challenge_digest");
  if(!/^sha256:[a-f0-9]{64}$/.test(String(receipt?.planDigest||""))) reasons.push("plan_digest");
  const approvals=receipt?.challenge?.approvalProofIds||[];
  if(new Set(approvals).size!==approvals.length) reasons.push("duplicate_approvals");
  return {
    schema:"aftergraph.custody-recovery-canary-verification/v1",
    valid:reasons.length===0,
    state:reasons.length===0?"VERIFIED_NON_ECONOMIC_RECOVERY_DRY_RUN":"INVALID",
    final:false,
    promotionAuthority:false,
    canMoveAssets:false,
    externalEffects:0,
    reasons
  };
}

export function verifyCustodyReferenceRevocation(revocation) {
  const reasons=[];
  if(revocation?.schema!=="aftergraph.custody-reference-revocation/v1") reasons.push("schema");
  if(revocation?.state!=="REVOKED") reasons.push("state");
  if(!String(revocation?.reason||"")) reasons.push("reason");
  if(revocation?.canMoveAssets!==false) reasons.push("move_capability");
  if(revocation?.externalEffects!==0) reasons.push("external_effects");
  return {
    schema:"aftergraph.custody-reference-revocation-verification/v1",
    valid:reasons.length===0,
    state:reasons.length===0?"VERIFIED_CUSTODY_REFERENCE_REVOCATION":"INVALID",
    final:false,
    promotionAuthority:false,
    externalEffects:0,
    reasons
  };
}
