import { createHash } from "node:crypto";

const HASH=/^sha256:[a-f0-9]{64}$/;
const GENESIS="sha256:"+"0".repeat(64);
const DECISIONS=new Set(["ADVANCED","ADVANCED_POLICY","ROTATED"]);

function eventHash(ev){
  const parts=[
    ev.sourceClass,ev.sourceId,String(ev.sequence),String(ev.generation),
    ev.decision,ev.stateDigest,ev.authorizationDigest||"",ev.previousEventHash
  ];
  return "sha256:"+createHash("sha256").update(parts.join("\0")).digest("hex");
}

export function verifyEconomicTrustRootHistory(events){
  const reasons=[];
  if(!Array.isArray(events)||events.length===0) reasons.push("history_empty");
  let previousHash=GENESIS;
  let previousGeneration=null;
  let sourceClass=null;
  let sourceId=null;

  for(let i=0;i<(Array.isArray(events)?events.length:0);i++){
    const ev=events[i];
    const expectedSequence=i+1;
    if(!["registry","custody","representation"].includes(ev?.sourceClass)) reasons.push("event_"+expectedSequence+":source_class");
    if(!String(ev?.sourceId||"")) reasons.push("event_"+expectedSequence+":source_id");
    if(sourceClass===null){sourceClass=ev?.sourceClass;sourceId=ev?.sourceId;}
    else if(ev?.sourceClass!==sourceClass||ev?.sourceId!==sourceId) reasons.push("event_"+expectedSequence+":source_identity_changed");

    if(ev?.sequence!==expectedSequence) reasons.push("event_"+expectedSequence+":sequence");
    if(!Number.isInteger(ev?.generation)||ev.generation<=0) reasons.push("event_"+expectedSequence+":generation");
    if(previousGeneration!==null&&ev?.generation!==previousGeneration+1) reasons.push("event_"+expectedSequence+":generation_continuity");
    if(!DECISIONS.has(ev?.decision)) reasons.push("event_"+expectedSequence+":decision");
    if(i===0&&ev?.decision!=="ADVANCED") reasons.push("event_1:genesis_decision");
    if(!HASH.test(String(ev?.stateDigest||""))) reasons.push("event_"+expectedSequence+":state_digest");

    if(ev?.decision==="ROTATED"){
      if(!HASH.test(String(ev?.authorizationDigest||""))) reasons.push("event_"+expectedSequence+":authorization_digest");
    }else if(String(ev?.authorizationDigest||"")!==""){
      reasons.push("event_"+expectedSequence+":unexpected_authorization_digest");
    }

    if(ev?.previousEventHash!==previousHash) reasons.push("event_"+expectedSequence+":previous_hash");
    if(!HASH.test(String(ev?.eventHash||""))) reasons.push("event_"+expectedSequence+":event_hash");
    else if(ev.eventHash!==eventHash(ev)) reasons.push("event_"+expectedSequence+":event_hash_binding");

    previousHash=ev?.eventHash;
    previousGeneration=ev?.generation;
  }

  const unique=[...new Set(reasons)].sort();
  return {
    schema:"aftergraph.economic-source-trust-root-history-verification/v1",
    valid:unique.length===0,
    state:unique.length===0?"VERIFIED_IMMUTABLE_TRUST_ROOT_LINEAGE":"INVALID",
    sourceClass,
    sourceId,
    eventCount:Array.isArray(events)?events.length:0,
    headEventHash:unique.length===0?previousHash:null,
    executionAuthority:false,
    final:false,
    promotionAuthority:false,
    externalEffects:0,
    reasons:unique
  };
}
