import { createHash } from "node:crypto";

const HASH=/^sha256:[a-f0-9]{64}$/;
const CLASSES=new Set(["registry","custody","representation"]);
const STATUS=new Set(["ACTIVE","REVOKED"]);

function digest(state){
  const parts=[
    state.sourceClass,state.sourceId,state.trustRootId,state.publicKeyFingerprint,
    String(state.generation),String(state.minAttestationGeneration),state.status,
    String(state.validFromUnix),String(state.validUntilUnix),String(state.revision)
  ];
  return "sha256:"+createHash("sha256").update(parts.join("\0")).digest("hex");
}

function validateState(state,reasons,prefix){
  if(!CLASSES.has(state?.sourceClass)) reasons.push(prefix+":source_class");
  if(!String(state?.sourceId||"")) reasons.push(prefix+":source_id");
  if(!String(state?.trustRootId||"")) reasons.push(prefix+":trust_root_id");
  if(!HASH.test(String(state?.publicKeyFingerprint||""))) reasons.push(prefix+":fingerprint");
  if(!Number.isInteger(state?.generation)||state.generation<=0) reasons.push(prefix+":generation");
  if(!Number.isInteger(state?.minAttestationGeneration)||state.minAttestationGeneration<=0) reasons.push(prefix+":attestation_floor");
  if(!STATUS.has(state?.status)) reasons.push(prefix+":status");
  if(!Number.isInteger(state?.validFromUnix)||!Number.isInteger(state?.validUntilUnix)||state.validFromUnix<=0||state.validUntilUnix<=state.validFromUnix) reasons.push(prefix+":validity");
  if(!Number.isInteger(state?.revision)||state.revision<=0) reasons.push(prefix+":revision");
  if(!HASH.test(String(state?.stateDigest||""))) reasons.push(prefix+":state_digest");
  else if(state.stateDigest!==digest(state)) reasons.push(prefix+":state_digest_binding");
}

export function verifyEconomicTrustRootTransition(prior,transition){
  const reasons=[];
  if(transition?.schema!=="aftergraph.economic-source-trust-root-transition/v1") reasons.push("transition_schema");
  if(transition?.externalEffects!==0) reasons.push("external_effects");
  const current=transition?.current||{};
  validateState(current,reasons,"current");

  const hasPrior=prior!=null;
  if(hasPrior) validateState(prior,reasons,"prior");

  let expectedDecision=null;
  if(!hasPrior){
    if(current.revision!==1) reasons.push("genesis_revision");
    if(transition?.priorGeneration!==0) reasons.push("genesis_prior_generation");
    expectedDecision="ADVANCED";
  }else{
    if(current.sourceClass!==prior.sourceClass||current.sourceId!==prior.sourceId) reasons.push("source_identity_changed");
    if(transition?.priorGeneration!==prior.generation) reasons.push("prior_generation_binding");

    if(current.generation<prior.generation){
      reasons.push("generation_regression");
    }else if(current.generation===prior.generation){
      const replay=[
        "sourceClass","sourceId","trustRootId","publicKeyFingerprint","generation",
        "minAttestationGeneration","status","validFromUnix","validUntilUnix"
      ].every(k=>current[k]===prior[k]);
      if(!replay) reasons.push("same_generation_equivocation");
      if(current.revision!==prior.revision) reasons.push("replay_revision_changed");
      expectedDecision="IDEMPOTENT_REPLAY";
    }else{
      if(current.generation!==prior.generation+1) reasons.push("generation_gap");
      if(current.revision!==prior.revision+1) reasons.push("revision_gap");
      if(current.minAttestationGeneration<prior.minAttestationGeneration) reasons.push("attestation_floor_regression");
      if(current.validFromUnix<prior.validFromUnix) reasons.push("validity_regression");
      const sameKey=current.publicKeyFingerprint===prior.publicKeyFingerprint&&current.trustRootId===prior.trustRootId;
      if(prior.status==="REVOKED"&&sameKey&&current.status==="ACTIVE") reasons.push("revoked_key_revival");
      expectedDecision=sameKey?"ADVANCED_POLICY":"ROTATED";
    }
  }

  if(expectedDecision&&transition?.decision!==expectedDecision) reasons.push("decision_mismatch");
  const unique=[...new Set(reasons)].sort();
  return {
    schema:"aftergraph.economic-source-trust-root-transition-verification/v1",
    valid:unique.length===0,
    state:unique.length===0?"VERIFIED_TRUST_ROOT_TRANSITION":"INVALID",
    decision:transition?.decision||null,
    executionAuthority:false,
    final:false,
    promotionAuthority:false,
    externalEffects:0,
    reasons:unique
  };
}
