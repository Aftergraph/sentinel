function isHash(v){return /^sha256:[a-f0-9]{64}$/.test(String(v||""));}

export function verifyEvidenceCoherence(input){
  const reasons=[];
  const policy=input?.policy||{};
  const observations=Array.isArray(input?.observations)?input.observations:[];
  const previous=input?.previousGenerations||{};
  const claimed=input?.coherence||{};

  if(!Number.isInteger(policy.nowUnix)||policy.nowUnix<=0) reasons.push("policy:now");
  if(!Number.isInteger(policy.maxAgeSeconds)||policy.maxAgeSeconds<=0) reasons.push("policy:max_age");
  if(!Number.isInteger(policy.maxSkewSeconds)||policy.maxSkewSeconds<0) reasons.push("policy:max_skew");
  if(!Number.isInteger(policy.maxFutureSkewSeconds)||policy.maxFutureSkewSeconds<0) reasons.push("policy:max_future_skew");

  const required=new Set(["registry","custody","representation"]);
  const seenClass=new Set();
  const seenEvidence=new Map();
  let oldest=0, newest=0;

  for(const obs of observations){
    const cls=String(obs?.sourceClass||"");
    if(!required.has(cls)){reasons.push(cls+":unsupported_source_class");continue;}
    if(seenClass.has(cls)){reasons.push(cls+":duplicate_source_class");continue;}
    seenClass.add(cls);
    if(!String(obs?.sourceId||"")) reasons.push(cls+":source_id");
    if(!isHash(obs?.evidenceHash)) reasons.push(cls+":evidence_hash");
    else if(seenEvidence.has(obs.evidenceHash)) reasons.push(cls+":evidence_reused_with_"+seenEvidence.get(obs.evidenceHash));
    else seenEvidence.set(obs.evidenceHash,cls);

    if(!Number.isInteger(obs?.generation)||obs.generation<=0) reasons.push(cls+":generation");
    const prior=previous[obs?.sourceId];
    if(Number.isInteger(prior)&&Number.isInteger(obs?.generation)&&obs.generation<=prior) reasons.push(cls+":generation_replayed_or_regressed");

    if(!Number.isInteger(obs?.observedAtUnix)||obs.observedAtUnix<=0) reasons.push(cls+":observed_at");
    else {
      if(Number.isInteger(policy.nowUnix)&&Number.isInteger(policy.maxFutureSkewSeconds)&&obs.observedAtUnix>policy.nowUnix+policy.maxFutureSkewSeconds) reasons.push(cls+":future_timestamp");
      if(Number.isInteger(policy.nowUnix)&&Number.isInteger(policy.maxAgeSeconds)&&policy.nowUnix-obs.observedAtUnix>policy.maxAgeSeconds) reasons.push(cls+":stale");
      if(oldest===0||obs.observedAtUnix<oldest) oldest=obs.observedAtUnix;
      if(obs.observedAtUnix>newest) newest=obs.observedAtUnix;
    }
  }
  for(const cls of required) if(!seenClass.has(cls)) reasons.push(cls+":missing");
  if(oldest>0&&newest>0&&Number.isInteger(policy.maxSkewSeconds)&&newest-oldest>policy.maxSkewSeconds) reasons.push("source_observation_skew_exceeded");

  const underlyingValid=reasons.length===0;
  if(claimed?.schema!=="aftergraph.economic-evidence-coherence/v1") reasons.push("claim:schema");
  if(claimed?.final!==false) reasons.push("claim:finality");
  if(claimed?.externalEffects!==0) reasons.push("claim:external_effects");
  if(underlyingValid){
    if(claimed?.state!=="TEMPORALLY_COHERENT") reasons.push("claim:state");
    if(claimed?.refreshRequired!==false) reasons.push("claim:refresh");
  }else{
    if(claimed?.state==="TEMPORALLY_COHERENT") reasons.push("claim:overclaims_coherence");
    if(claimed?.refreshRequired!==true) reasons.push("claim:missing_refresh");
  }

  return {
    schema:"aftergraph.economic-evidence-coherence-verification/v1",
    valid:reasons.length===0,
    state:reasons.length===0?"VERIFIED_TEMPORAL_COHERENCE":"EVIDENCE_REFRESH_REQUIRED",
    temporallyCoherent:reasons.length===0,
    oldestObservedAtUnix:oldest,
    newestObservedAtUnix:newest,
    final:false,
    promotionAuthority:false,
    externalEffects:0,
    reasons:[...new Set(reasons)].sort()
  };
}
