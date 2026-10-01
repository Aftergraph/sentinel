import { createHash } from "node:crypto";
import { verifyEconomicTrustRootTransition } from "./economic-source-trust-root-ledger.js";

const HASH=/^sha256:[a-f0-9]{64}$/;

function authorizationDigest(payload){
  const approvals=[...(payload?.approvalProofIds||[])].sort();
  const parts=[
    "aftergraph/economic-trust-root-rotation/v1",
    "GOVERNED_TRUST_ROOT_ROTATION",
    payload?.sourceClass,payload?.sourceId,
    payload?.priorTrustRootId,payload?.newTrustRootId,
    payload?.priorPublicKeyFingerprint,payload?.newPublicKeyFingerprint,
    String(payload?.priorGeneration),String(payload?.newGeneration),
    String(payload?.priorMinAttestationGeneration),String(payload?.newMinAttestationGeneration),
    payload?.authorityLeaseId,approvals.join(","),
    payload?.rotationNonce,payload?.reason,String(payload?.expiresAt)
  ];
  return "sha256:"+createHash("sha256").update(parts.join("\x00")).digest("hex");
}

export function verifyEconomicTrustRootRotationAuthorization(prior,next,authorization,nowMillis=Date.now()){
  const reasons=[];
  if(authorization?.schema!=="aftergraph.economic-trust-root-rotation-authorization/v1") reasons.push("schema");
  if(authorization?.decision!=="AUTHORIZED_PREPARE_ONLY") reasons.push("decision");
  if(authorization?.authorized!==true) reasons.push("authorized");
  if(authorization?.trustRootMutationAuthorized!==true) reasons.push("mutation_authority");
  if(authorization?.approvalsVerified!==true) reasons.push("approvals_verified");
  if(authorization?.authorityVerified!==true) reasons.push("authority_verified");
  if(authorization?.executionAuthority!==false) reasons.push("execution_authority");
  if(authorization?.liveValueEnabled!==false) reasons.push("live_value");
  if(authorization?.final!==false) reasons.push("finality");
  if(authorization?.promotionAuthority!==false) reasons.push("promotion_authority");
  if(authorization?.externalEffects!==0) reasons.push("external_effects");

  const p=authorization?.payload||{};
  if(p.sourceClass!==prior?.sourceClass||p.sourceClass!==next?.sourceClass) reasons.push("source_class_binding");
  if(p.sourceId!==prior?.sourceId||p.sourceId!==next?.sourceId) reasons.push("source_id_binding");
  if(p.priorTrustRootId!==prior?.trustRootId) reasons.push("prior_root_binding");
  if(p.newTrustRootId!==next?.trustRootId) reasons.push("new_root_binding");
  if(p.priorPublicKeyFingerprint!==prior?.publicKeyFingerprint) reasons.push("prior_fingerprint_binding");
  if(p.newPublicKeyFingerprint!==next?.publicKeyFingerprint) reasons.push("new_fingerprint_binding");
  if(p.priorGeneration!==prior?.generation) reasons.push("prior_generation_binding");
  if(p.newGeneration!==next?.generation||p.newGeneration!==p.priorGeneration+1) reasons.push("new_generation_binding");
  if(p.priorMinAttestationGeneration!==prior?.minAttestationGeneration) reasons.push("prior_floor_binding");
  if(p.newMinAttestationGeneration!==next?.minAttestationGeneration||p.newMinAttestationGeneration<p.priorMinAttestationGeneration) reasons.push("new_floor_binding");
  if(!/^auth_[A-Za-z0-9_-]{12,}$/.test(String(p.authorityLeaseId||""))) reasons.push("authority_lease");
  const approvals=Array.isArray(p.approvalProofIds)?p.approvalProofIds:[];
  if(approvals.length<2||new Set(approvals).size!==approvals.length||approvals.some(x=>!/^apr_[A-Za-z0-9_-]{12,}$/.test(String(x)))) reasons.push("two_person_approval");
  if(!/^rot_[A-Za-z0-9_-]{12,}$/.test(String(p.rotationNonce||""))) reasons.push("rotation_nonce");
  if(!Number.isFinite(p.expiresAt)||p.expiresAt<=nowMillis) reasons.push("expired");
  if(!HASH.test(String(authorization?.authorizationDigest||""))) reasons.push("authorization_digest");
  else if(authorization.authorizationDigest!==authorizationDigest(p)) reasons.push("authorization_digest_binding");

  const unique=[...new Set(reasons)].sort();
  return {
    schema:"aftergraph.economic-trust-root-rotation-authorization-verification/v1",
    valid:unique.length===0,
    state:unique.length===0?"VERIFIED_ROTATION_AUTHORIZATION":"INVALID",
    authorized:unique.length===0,
    executionAuthority:false,
    final:false,
    promotionAuthority:false,
    externalEffects:0,
    reasons:unique
  };
}

export function verifyAuthorizedEconomicTrustRootTransition(prior,transition,authorization,nowMillis=Date.now()){
  const auth=verifyEconomicTrustRootRotationAuthorization(prior,transition?.current,authorization,nowMillis);
  const transitionVerification=verifyEconomicTrustRootTransition(prior,transition);
  const reasons=[];
  if(!auth.valid) reasons.push("authorization_invalid");
  if(!transitionVerification.valid) reasons.push("transition_invalid");
  if(transition?.decision!=="ROTATED") reasons.push("rotation_decision_required");

  const unique=[...new Set(reasons)].sort();
  return {
    schema:"aftergraph.economic-authorized-trust-root-transition-verification/v1",
    valid:unique.length===0,
    state:unique.length===0?"VERIFIED_AUTHORIZED_TRUST_ROOT_ROTATION":"INVALID",
    authorization:auth,
    transition:transitionVerification,
    executionAuthority:false,
    liveValueEnabled:false,
    final:false,
    promotionAuthority:false,
    externalEffects:0,
    reasons:unique
  };
}
