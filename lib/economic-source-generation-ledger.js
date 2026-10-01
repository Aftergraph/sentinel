import { createHash } from "node:crypto";

const HASH=/^sha256:[a-f0-9]{64}$/;
const CLASSES=new Set(["registry","custody","representation"]);
const CURSORS=new Set(["version","sequence","block","offset","etag"]);

function digestState(state){
  const parts=[
    state.sourceClass,
    state.sourceId,
    String(state.generation),
    state.cursorKind,
    state.cursorValue,
    String(state.observedAtUnix),
    state.evidenceHash,
    state.recordDigest,
    state.captureHash,
    String(state.revision)
  ];
  return "sha256:"+createHash("sha256").update(parts.join("\x00")).digest("hex");
}

function validState(state){
  return state &&
    CLASSES.has(state.sourceClass) &&
    String(state.sourceId||"").length>0 &&
    Number.isInteger(state.generation) && state.generation>0 &&
    CURSORS.has(state.cursorKind) &&
    String(state.cursorValue||"").length>0 &&
    Number.isInteger(state.observedAtUnix) && state.observedAtUnix>0 &&
    HASH.test(String(state.evidenceHash||"")) &&
    HASH.test(String(state.recordDigest||"")) &&
    HASH.test(String(state.captureHash||""));
}

function exactReplay(a,b){
  return a?.sourceClass===b?.sourceClass &&
    a?.sourceId===b?.sourceId &&
    a?.generation===b?.generation &&
    a?.cursorKind===b?.cursorKind &&
    a?.cursorValue===b?.cursorValue &&
    a?.observedAtUnix===b?.observedAtUnix &&
    a?.evidenceHash===b?.evidenceHash &&
    a?.recordDigest===b?.recordDigest &&
    a?.captureHash===b?.captureHash;
}

export function verifyEconomicSourceGenerationTransition(input){
  const reasons=[];
  const prior=input?.prior??null;
  const proposed=input?.proposed??null;
  const transition=input?.transition??{};

  if(!validState(proposed)) reasons.push("proposed_state");
  if(prior!==null && !validState(prior)) reasons.push("prior_state");
  if(prior!==null && prior?.stateDigest!==digestState(prior)) reasons.push("prior_state_digest");

  let expectedDecision=null;
  let expectedCurrent=null;
  let expectedPriorGeneration=0;

  if(validState(proposed) && (prior===null || validState(prior))){
    if(prior===null){
      expectedDecision="ADVANCED";
      expectedCurrent={...proposed,revision:1};
      expectedCurrent.stateDigest=digestState(expectedCurrent);
    }else{
      expectedPriorGeneration=prior.generation;
      if(proposed.sourceClass!==prior.sourceClass || proposed.sourceId!==prior.sourceId){
        reasons.push("identity_changed");
      }else if(proposed.generation<prior.generation){
        reasons.push("generation_regression");
      }else if(proposed.generation===prior.generation){
        if(!exactReplay(prior,proposed)){
          reasons.push("generation_equivocation");
        }else{
          expectedDecision="IDEMPOTENT_REPLAY";
          expectedCurrent={...prior};
        }
      }else if(proposed.observedAtUnix<prior.observedAtUnix){
        reasons.push("time_regression");
      }else if(proposed.cursorKind!==prior.cursorKind){
        reasons.push("cursor_kind_change");
      }else{
        expectedDecision="ADVANCED";
        expectedCurrent={...proposed,revision:prior.revision+1};
        expectedCurrent.stateDigest=digestState(expectedCurrent);
      }
    }
  }

  if(transition?.schema!=="aftergraph.economic-source-generation-transition/v1") reasons.push("transition_schema");
  if(transition?.externalEffects!==0) reasons.push("transition_external_effects");

  if(expectedDecision===null){
    if(transition?.decision==="ADVANCED"||transition?.decision==="IDEMPOTENT_REPLAY"){
      reasons.push("transition_overclaims_acceptance");
    }
  }else{
    if(transition?.decision!==expectedDecision) reasons.push("transition_decision");
    if(transition?.priorGeneration!==expectedPriorGeneration) reasons.push("transition_prior_generation");
    if(JSON.stringify(transition?.current)!==JSON.stringify(expectedCurrent)) reasons.push("transition_current_state");
  }

  const unique=[...new Set(reasons)].sort();
  return {
    schema:"aftergraph.economic-source-generation-transition-verification/v1",
    valid:unique.length===0,
    state:unique.length===0?"VERIFIED_SOURCE_GENERATION_TRANSITION":"INVALID",
    decision:unique.length===0?expectedDecision:null,
    executionAuthority:false,
    final:false,
    promotionAuthority:false,
    externalEffects:0,
    reasons:unique
  };
}
